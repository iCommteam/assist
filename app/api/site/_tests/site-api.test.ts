import type * as EveClient from "eve/client";
import type { ReceivedEvent } from "eve/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ensureScope } from "@db/services/scope";
import type {
  findSiteTaskSession,
  recordSiteTask,
  resolveSiteOwner,
} from "@db/services/sites";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { verifySiteCredential } from "@shared/identity/site-credential";
import { eventsOf } from "@tests/helpers/session-view";

const eve = vi.hoisted(() => ({
  bearers: new Array<() => Promise<string>>(),
  baseUrls: new Array<string>(),
  create:
    vi.fn<
      (input: { message: string }) => Promise<{ session: { id: string } }>
    >(),
  read: vi.fn<(sessionId: string) => Promise<ReceivedEvent[]>>(),
}));
const services = vi.hoisted(() => ({
  ensureScope: vi.fn<typeof ensureScope>(),
  findSiteTaskSession: vi.fn<typeof findSiteTaskSession>(),
  recordSiteTask: vi.fn<typeof recordSiteTask>(),
  resolveSiteOwner: vi.fn<typeof resolveSiteOwner>(),
}));

vi.mock("eve/client", async (importOriginal) => {
  const original = await importOriginal<typeof EveClient>();
  class FakeClient {
    readonly sessions = {
      attach: (sessionId: string) => ({
        async *stream() {
          yield* await eve.read(sessionId);
        },
      }),
      create: eve.create,
    };

    constructor(options: {
      auth: { bearer: () => Promise<string> };
      baseUrl: string;
    }) {
      eve.bearers.push(options.auth.bearer);
      eve.baseUrls.push(options.baseUrl);
    }
  }
  return { ...original, Client: FakeClient };
});
vi.mock("@db/services/scope", () => ({ ensureScope: services.ensureScope }));
vi.mock("@db/services/sites", () => ({
  findSiteTaskSession: services.findSiteTaskSession,
  recordSiteTask: services.recordSiteTask,
  resolveSiteOwner: services.resolveSiteOwner,
}));

const { GET: ping } = await import("@app/api/site/ping/route");
const { POST: createTask } = await import("@app/api/site/tasks/route");
const { GET: readTask } = await import("@app/api/site/tasks/[taskId]/route");
const { ClientError } = await import("eve/client");

const teemiqToken = "teemiq-test-token-0123456789abcdef";
const agentsToken = "agents-test-token-0123456789abcdef";
const owner = accessScopeForUser("better-auth:owner-1");
const taskId = "00000000-0000-4000-8000-000000000001";
const siteVariables = [
  ["ASSIST_SITE_TOKEN_TEEMIQ", teemiqToken],
  ["ASSIST_SITE_OWNER_TEEMIQ", "owner@example.test"],
  ["ASSIST_SITE_TOKEN_AGENTS", agentsToken],
  ["ASSIST_SITE_OWNER_AGENTS", "owner@example.test"],
] as const;

// The route keeps each site's recent task starts in memory for ten minutes.
// Only Date is faked, and each test starts an hour after the last, so no test
// inherits another's starts.
let clock = Date.parse("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  clock += 60 * 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  eve.bearers.length = 0;
  eve.baseUrls.length = 0;
  for (const [name, value] of siteVariables) vi.stubEnv(name, value);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  services.resolveSiteOwner.mockResolvedValue({
    email: "owner@example.test",
    ok: true,
    scope: owner,
  });
  services.recordSiteTask.mockResolvedValue(taskId);
  services.findSiteTaskSession.mockResolvedValue({
    createdAt: new Date(),
    sessionId: "wrun_1",
  });
  eve.create.mockResolvedValue({ session: { id: "wrun_1" } });
  eve.read.mockResolvedValue([]);
});

afterEach(() => {
  for (const [name] of siteVariables) vi.stubEnv(name, "");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("site API authentication", () => {
  it("answers ping for a site's own token", async () => {
    const response = await ping(siteRequest("/ping", teemiqToken));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      site: "teemiq",
    });
    expect(services.resolveSiteOwner).toHaveBeenCalledExactlyOnceWith("teemiq");
  });

  it.each([
    ["no Authorization header", undefined],
    ["a wrong token", "Bearer not-a-configured-site-token-0123456789"],
    ["another scheme", `Basic ${teemiqToken}`],
    ["an empty bearer", "Bearer "],
  ])("refuses %s with 401", async (_case, authorization) => {
    const request = new Request("https://assist.example/api/site/ping", {
      headers: authorization ? { authorization } : {},
    });

    const response = await ping(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(services.resolveSiteOwner).not.toHaveBeenCalled();
  });

  it.each([["owner has no account"], ["owner has no authenticator"]])(
    "refuses every call with 403 when the %s, and logs why",
    async (reason) => {
      services.resolveSiteOwner.mockResolvedValue({ ok: false, reason });

      const responses = await Promise.all([
        ping(siteRequest("/ping", teemiqToken)),
        createTask(siteRequest("/tasks", teemiqToken, { message: "hello" })),
        readTask(siteRequest(`/tasks/${taskId}`, teemiqToken), params(taskId)),
      ]);

      expect(responses.map(({ status }) => status)).toEqual([403, 403, 403]);
      await expect(
        Promise.all(responses.map((response) => response.json()))
      ).resolves.toEqual([
        { error: "forbidden" },
        { error: "forbidden" },
        { error: "forbidden" },
      ]);
      expect(console.warn).toHaveBeenCalledWith("[site] call refused", {
        reason,
        site: "teemiq",
      });
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
        teemiqToken
      );
      expect(eve.create).not.toHaveBeenCalled();
      expect(eve.read).not.toHaveBeenCalled();
    }
  );
});

describe("site API database errors", () => {
  it("answers every call with 503 JSON when the owner lookup fails", async () => {
    services.resolveSiteOwner.mockRejectedValue(new Error("pool timeout"));

    const responses = await Promise.all([
      ping(siteRequest("/ping", teemiqToken)),
      createTask(siteRequest("/tasks", teemiqToken, { message: "hello" })),
      readTask(siteRequest(`/tasks/${taskId}`, teemiqToken), params(taskId)),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([503, 503, 503]);
    expect(
      responses.map((response) => response.headers.get("cache-control"))
    ).toEqual(["no-store", "no-store", "no-store"]);
    await expect(
      Promise.all(responses.map((response) => response.json()))
    ).resolves.toEqual([
      { error: "unavailable" },
      { error: "unavailable" },
      { error: "unavailable" },
    ]);
    expect(eve.create).not.toHaveBeenCalled();
    expect(eve.read).not.toHaveBeenCalled();
  });

  it("answers a task read with 503 JSON when the task lookup fails", async () => {
    services.findSiteTaskSession.mockRejectedValue(new Error("pool timeout"));

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
    expect(eve.read).not.toHaveBeenCalled();
  });
});

describe("POST /api/site/tasks", () => {
  it("starts the task as the owner and returns its id", async () => {
    const response = await createTask(
      siteRequest("/tasks", teemiqToken, {
        message: "Reply with exactly: pong",
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ taskId });
    expect(services.ensureScope).toHaveBeenCalledExactlyOnceWith(owner);
    expect(eve.create).toHaveBeenCalledExactlyOnceWith({
      message: "Reply with exactly: pong",
    });
    expect(services.recordSiteTask).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      "wrun_1"
    );
    expect(eve.baseUrls).toEqual(["http://127.0.0.1:4274"]);
    expect(await grantOfLastClient()).toEqual({ op: "create", site: "teemiq" });
  });

  it("accepts a message of exactly 8000 characters", async () => {
    const response = await createTask(
      siteRequest("/tasks", teemiqToken, { message: "x".repeat(8000) })
    );

    expect(response.status).toBe(202);
  });

  it.each([
    ["an empty body", ""],
    ["invalid JSON", "{"],
    ["no message", "{}"],
    ["an empty message", JSON.stringify({ message: "" })],
    ["a blank message", JSON.stringify({ message: "  \n " })],
    ["a non-string message", JSON.stringify({ message: 42 })],
    [
      "a message over 8000 characters",
      JSON.stringify({ message: "x".repeat(8001) }),
    ],
    ["a JSON array", "[]"],
  ])("refuses %s with 400", async (_case, body) => {
    const response = await createTask(
      new Request("https://assist.example/api/site/tasks", {
        body,
        headers: { authorization: `Bearer ${teemiqToken}` },
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
    expect(eve.create).not.toHaveBeenCalled();
  });

  it("refuses a body larger than the API accepts before reading it", async () => {
    const response = await createTask(
      new Request("https://assist.example/api/site/tasks", {
        body: JSON.stringify({ message: "hello" }),
        headers: {
          authorization: `Bearer ${teemiqToken}`,
          "content-length": String(1024 * 1024),
        },
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
  });

  it("retries recording a started task once the database recovers", async () => {
    services.recordSiteTask
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(taskId);

    const response = await createTask(
      siteRequest("/tasks", teemiqToken, { message: "hello" })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ taskId });
    expect(eve.create).toHaveBeenCalledOnce();
    expect(services.recordSiteTask).toHaveBeenCalledTimes(2);
  });

  it("answers 503 after three failed attempts to record a started task", async () => {
    services.recordSiteTask.mockRejectedValue(new Error("connection reset"));

    const response = await createTask(
      siteRequest("/tasks", teemiqToken, { message: "hello" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
    expect(eve.create).toHaveBeenCalledOnce();
    expect(services.recordSiteTask).toHaveBeenCalledTimes(3);
  });

  it("answers 503 and records nothing when eve does not accept the task", async () => {
    eve.create.mockRejectedValue(new ClientError(503, "{}"));

    const response = await createTask(
      siteRequest("/tasks", teemiqToken, { message: "hello" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
    expect(services.recordSiteTask).not.toHaveBeenCalled();
  });
});

describe("POST /api/site/tasks rate cap", () => {
  it("answers 429 with Retry-After at the eleventh start in ten minutes, before eve", async () => {
    const accepted = await startEveryMinute(10);
    vi.setSystemTime(clock + 9 * 60_000 + 30_000);

    const refused = await startTask(teemiqToken);

    expect(accepted).toEqual(Array.from({ length: 10 }, () => 202));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    // The first start leaves the window at minute ten.
    expect(refused.headers.get("retry-after")).toBe("30");
    await expect(refused.json()).resolves.toEqual({ error: "rate_limited" });
    expect(eve.create).toHaveBeenCalledTimes(10);
    expect(services.ensureScope).toHaveBeenCalledTimes(10);
    expect(services.recordSiteTask).toHaveBeenCalledTimes(10);
    expect(console.warn).toHaveBeenCalledWith(
      "[site] task start rate limited",
      { site: "teemiq" }
    );
  });

  it("slides the window one start at a time and counts each site apart", async () => {
    await startEveryMinute(10);

    vi.setSystemTime(clock + 10 * 60_000);
    const reopened = await startTask(teemiqToken);
    const full = await startTask(teemiqToken);
    const otherSite = await startTask(agentsToken);

    expect(reopened.status).toBe(202);
    expect(full.status).toBe(429);
    expect(full.headers.get("retry-after")).toBe("60");
    expect(otherSite.status).toBe(202);
  });

  it("does not count a request it refuses as invalid", async () => {
    const invalid = await Promise.all(
      Array.from({ length: 12 }, () =>
        createTask(
          new Request("https://assist.example/api/site/tasks", {
            body: "{}",
            headers: { authorization: `Bearer ${teemiqToken}` },
            method: "POST",
          })
        )
      )
    );

    expect(invalid.map(({ status }) => status)).toEqual(
      Array.from({ length: 12 }, () => 400)
    );
    expect((await startTask(teemiqToken)).status).toBe(202);
  });
});

function startTask(token: string) {
  return createTask(siteRequest("/tasks", token, { message: "hello" }));
}

// Starts one teemiq task at the top of each minute from the test's clock.
async function startEveryMinute(count: number) {
  const statuses: number[] = [];
  /* oxlint-disable eslint/no-await-in-loop -- Each start runs at its own minute. */
  for (let minute = 0; minute < count; minute += 1) {
    vi.setSystemTime(clock + minute * 60_000);
    statuses.push((await startTask(teemiqToken)).status);
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return statuses;
}

describe("GET /api/site/tasks/{taskId}", () => {
  it("returns the agent's reply once the task completes", async () => {
    eve.read.mockResolvedValue(completedPong());

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      error: null,
      reply: "pong",
      status: "completed",
      taskId,
    });
    expect(services.findSiteTaskSession).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      taskId
    );
    expect(eve.read).toHaveBeenCalledExactlyOnceWith("wrun_1");
    expect(await grantOfLastClient()).toEqual({
      op: "read",
      session: "wrun_1",
      site: "teemiq",
    });
  });

  it("answers 404 for another site's task", async () => {
    services.findSiteTaskSession.mockResolvedValue(undefined);

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, agentsToken),
      params(taskId)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
    expect(services.findSiteTaskSession).toHaveBeenCalledExactlyOnceWith(
      "agents",
      owner,
      taskId
    );
    expect(eve.read).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not a task id, without a lookup", async () => {
    const response = await readTask(
      siteRequest("/tasks/wrun_1", teemiqToken),
      params("wrun_1")
    );

    expect(response.status).toBe(404);
    expect(services.findSiteTaskSession).not.toHaveBeenCalled();
  });

  it("refuses a missing token with 401", async () => {
    const response = await readTask(
      new Request(`https://assist.example/api/site/tasks/${taskId}`),
      params(taskId)
    );

    expect(response.status).toBe(401);
    expect(services.findSiteTaskSession).not.toHaveBeenCalled();
  });

  it.each([
    // A task created just now whose run eve has not stored yet.
    [404, "{}", { error: null, reply: null, status: "running" }],
    [
      409,
      JSON.stringify({ code: "session_not_ready" }),
      { error: null, reply: null, status: "running" },
    ],
    [
      410,
      JSON.stringify({ code: "session_expired" }),
      { error: "The task record has expired.", reply: null, status: "failed" },
    ],
  ])("maps an eve %i to a task status", async (status, body, expected) => {
    eve.read.mockRejectedValue(new ClientError(status, body));

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ...expected, taskId });
  });

  it("reads a task whose run is gone as failed once it is past starting", async () => {
    eve.read.mockRejectedValue(new ClientError(404, "{}"));
    // Just inside the start window, eve's 404 still means the run is starting.
    services.findSiteTaskSession.mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 90_000),
      sessionId: "wrun_1",
    });
    const starting = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );
    await expect(starting.json()).resolves.toEqual({
      error: null,
      reply: null,
      status: "running",
      taskId,
    });

    // Ten minutes later the run is missing, not starting: a poller must stop.
    services.findSiteTaskSession.mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 10 * 60_000),
      sessionId: "wrun_1",
    });
    const missing = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual({
      error: "The task record is no longer available.",
      reply: null,
      status: "failed",
      taskId,
    });
    expect(console.warn).toHaveBeenCalledWith("[site] task run is missing", {
      site: "teemiq",
    });
  });

  it("answers 503 when eve cannot be read", async () => {
    eve.read.mockRejectedValue(new ClientError(500, "{}"));

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
  });
});

function siteRequest(path: string, token: string, body?: { message: string }) {
  return new Request(`https://assist.example/api/site${path}`, {
    ...(body
      ? { body: JSON.stringify(body), method: "POST" }
      : { method: "GET" }),
    headers: { authorization: `Bearer ${token}` },
  });
}

function params(id: string) {
  return { params: Promise.resolve({ taskId: id }) };
}

async function grantOfLastClient() {
  const bearer = eve.bearers.at(-1);
  if (!bearer) throw new Error("No eve client was created.");
  return verifySiteCredential(
    "test-auth-secret-0123456789abcdefghijklmnop",
    await bearer()
  );
}

function completedPong() {
  return eventsOf([
    [
      {
        data: { cause: { deliveryId: "d-1" }, follows: null, turnId: "turn_0" },
        type: "turn.started",
      },
      {
        data: { owner: { turnId: "turn_0" }, runId: "run-1" },
        scope: { runId: "run-1", turnId: "turn_0" },
        type: "model.requested",
      },
    ],
    [
      {
        data: {
          callId: "call-1",
          capability: { kind: "tool", name: "send_message" },
          input: { kind: "message", text: "pong" },
          owner: { runId: "run-1" },
        },
        scope: { runId: "run-1", turnId: "turn_0" },
        type: "call.requested",
      },
      {
        data: {
          callId: "call-1",
          outcome: "completed",
          output: { kind: "message", text: "pong" },
        },
        scope: { runId: "run-1", turnId: "turn_0" },
        type: "call.settled",
      },
    ],
    [
      {
        data: { outcome: "completed", turnId: "turn_0" },
        scope: { turnId: "turn_0" },
        type: "turn.settled",
      },
    ],
  ]);
}
