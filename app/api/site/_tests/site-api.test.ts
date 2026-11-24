import type * as EveClient from "eve/client";
import type { Fact, ReceivedEvent } from "eve/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ensureScope } from "@db/services/scope";
import type {
  countSiteTaskFiles,
  findSiteTaskSession,
  listSiteTasksOfLogin,
  readSiteTaskSignInOrigin,
  recordSiteTask,
  resolveSiteOwner,
} from "@db/services/sites";
import type { readSiteLoginPin } from "@db/services/vault";
import type { closeLeftLoginWriters } from "@web/browser/login-profile";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { verifySiteCredential } from "@shared/identity/site-credential";
import { openSiteCode } from "@shared/identity/site-code/seal";
import { eventsOf } from "@tests/helpers/session-view";

const eve = vi.hoisted(() => ({
  bearers: new Array<() => Promise<string>>(),
  baseUrls: new Array<string>(),
  cancel:
    vi.fn<
      (
        sessionId: string,
        turnId: string | null | undefined
      ) => Promise<undefined>
    >(),
  create:
    vi.fn<
      (input: { message: string }) => Promise<{ session: { id: string } }>
    >(),
  read: vi.fn<(sessionId: string) => Promise<ReceivedEvent[]>>(),
  respond:
    vi.fn<
      (
        sessionId: string,
        answers: readonly { interactionId: string; text?: string }[]
      ) => Promise<undefined>
    >(),
}));
const services = vi.hoisted(() => ({
  closeLeftLoginWriters: vi.fn<typeof closeLeftLoginWriters>(),
  countSiteTaskFiles: vi.fn<typeof countSiteTaskFiles>(),
  ensureScope: vi.fn<typeof ensureScope>(),
  findSiteTaskSession: vi.fn<typeof findSiteTaskSession>(),
  listSiteTasksOfLogin: vi.fn<typeof listSiteTasksOfLogin>(),
  recordSiteTask: vi.fn<typeof recordSiteTask>(),
  readSiteLoginPin: vi.fn<typeof readSiteLoginPin>(),
  readSiteTaskSignInOrigin: vi.fn<typeof readSiteTaskSignInOrigin>(),
  resolveSiteOwner: vi.fn<typeof resolveSiteOwner>(),
}));

vi.mock("eve/client", async (importOriginal) => {
  const original = await importOriginal<typeof EveClient>();
  class FakeClient {
    readonly sessions = {
      attach: (sessionId: string) => ({
        cancel: async (options: { readonly turnId?: string | null }) =>
          eve.cancel(sessionId, options.turnId),
        respond: async (
          answers: readonly { interactionId: string; text?: string }[]
        ) => eve.respond(sessionId, answers),
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
  countSiteTaskFiles: services.countSiteTaskFiles,
  findSiteTaskSession: services.findSiteTaskSession,
  listSiteTasksOfLogin: services.listSiteTasksOfLogin,
  readSiteTaskSignInOrigin: services.readSiteTaskSignInOrigin,
  recordSiteTask: services.recordSiteTask,
  resolveSiteOwner: services.resolveSiteOwner,
}));
vi.mock("@db/services/vault", () => ({
  readSiteLoginPin: services.readSiteLoginPin,
}));
vi.mock("@web/browser/login-profile", () => ({
  closeLeftLoginWriters: services.closeLeftLoginWriters,
}));

const { GET: ping } = await import("@app/api/site/ping/route");
const { GET: listTasks, POST: createTask } =
  await import("@app/api/site/tasks/route");
const { GET: readTask } = await import("@app/api/site/tasks/[taskId]/route");
const { POST: sendInput } =
  await import("@app/api/site/tasks/[taskId]/input/route");
const { POST: cancelTask } =
  await import("@app/api/site/tasks/[taskId]/cancel/route");
const { ClientError, SessionNotActiveError } = await import("eve/client");

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
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  services.resolveSiteOwner.mockResolvedValue({
    email: "owner@example.test",
    ok: true,
    scope: owner,
  });
  services.recordSiteTask.mockResolvedValue(taskId);
  services.findSiteTaskSession.mockResolvedValue({
    createdAt: new Date(),
    kind: "fetch",
    sessionId: "wrun_1",
  });
  services.readSiteLoginPin.mockResolvedValue({
    alsoHosts: [],
    id: "login-1",
    origin: "https://login.vendor.example",
  });
  services.readSiteTaskSignInOrigin.mockResolvedValue(null);
  services.listSiteTasksOfLogin.mockResolvedValue([]);
  services.countSiteTaskFiles.mockResolvedValue(0);
  eve.create.mockResolvedValue({ session: { id: "wrun_1" } });
  eve.read.mockResolvedValue([]);
  eve.respond.mockResolvedValue(undefined);
  eve.cancel.mockResolvedValue(undefined);
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
      "wrun_1",
      undefined,
      "fetch"
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

describe("look tasks", () => {
  it("starts a look pinned to a login, recorded as one, with the kind in its grant", async () => {
    const response = await createTask(
      siteRequest("/tasks", teemiqToken, {
        kind: "look",
        loginId: "login-1",
        message: "Look at the November invoices.",
      })
    );

    expect(response.status).toBe(202);
    expect(services.recordSiteTask).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      "wrun_1",
      "login-1",
      "look"
    );
    expect(await grantOfLastClient()).toEqual({
      kind: "look",
      login: {
        alsoHosts: [],
        id: "login-1",
        origin: "https://login.vendor.example",
      },
      op: "create",
      site: "teemiq",
    });
  });

  it("keeps a start that names no kind, or fetch, a fetch with the grant earlier sites got", async () => {
    await createTask(
      siteRequest("/tasks", teemiqToken, {
        kind: "fetch",
        loginId: "login-1",
        message: "Fetch the October invoice.",
      })
    );

    expect(services.recordSiteTask.mock.calls.at(-1)?.at(-1)).toBe("fetch");
    expect(await grantOfLastClient()).not.toHaveProperty("kind");
  });

  it.each([
    ["a look without a login", { kind: "look", message: "Look." }],
    [
      "another kind",
      { kind: "download", loginId: "login-1", message: "Look." },
    ],
  ])("refuses %s", async (_case, body) => {
    const response = await createTask(siteRequest("/tasks", teemiqToken, body));

    expect(response.status).toBe(400);
    expect(eve.create).not.toHaveBeenCalled();
  });

  it.each([
    ["done", "listed"],
    ["nothing_found", "nothing_found"],
  ])(
    "reads a look the agent ended %s as %s, with its list as the reply and no files counted",
    async (result, outcome) => {
      services.findSiteTaskSession.mockResolvedValue({
        createdAt: new Date(),
        kind: "look",
        sessionId: "wrun_1",
      });
      eve.read.mockResolvedValue(lookEnded(result));

      const response = await readTask(
        siteRequest(`/tasks/${taskId}`, teemiqToken),
        params(taskId)
      );

      await expect(response.json()).resolves.toEqual({
        error: null,
        kind: "look",
        outcome,
        question: null,
        questionId: null,
        reply: "2026-11-03 INV-1 20.00 USD invoice",
        signInOrigin: null,
        status: "completed",
        taskId,
      });
      expect(services.countSiteTaskFiles).not.toHaveBeenCalled();
    }
  );
});

describe("POST /api/site/tasks login pin", () => {
  it("pins the task to a saved login of the owner's vault", async () => {
    const response = await createTask(
      siteRequest("/tasks", teemiqToken, {
        loginId: "login-1",
        message: "Fetch the October invoice.",
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ taskId });
    expect(services.readSiteLoginPin).toHaveBeenCalledExactlyOnceWith(
      owner,
      "teemiq",
      "login-1"
    );
    expect(eve.create).toHaveBeenCalledExactlyOnceWith({
      message: "Fetch the October invoice.",
    });
    expect(services.recordSiteTask).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      "wrun_1",
      "login-1",
      "fetch"
    );
    expect(await grantOfLastClient()).toEqual({
      login: {
        alsoHosts: [],
        id: "login-1",
        origin: "https://login.vendor.example",
      },
      op: "create",
      site: "teemiq",
    });
  });

  it("looks nothing up for a task without a pin", async () => {
    const response = await startTask(teemiqToken);

    expect(response.status).toBe(202);
    expect(services.readSiteLoginPin).not.toHaveBeenCalled();
    expect(await grantOfLastClient()).toEqual({ op: "create", site: "teemiq" });
  });

  // The vault service answers undefined alike for an unknown id, the owner's
  // own login, another site's, another workspace's item, another kind and a
  // login bound to no website; db/tests/sites.test.ts proves which.
  it("refuses a login the site did not save with the plain 400, uncounted", async () => {
    services.readSiteLoginPin.mockResolvedValue(undefined);

    const refused = await Promise.all(
      Array.from({ length: 11 }, () =>
        createTask(
          siteRequest("/tasks", teemiqToken, {
            loginId: "login-other",
            message: "hello",
          })
        )
      )
    );

    expect(refused.map(({ status }) => status)).toEqual(
      Array.from({ length: 11 }, () => 400)
    );
    await expect(refused[0]?.json()).resolves.toEqual({
      error: "invalid_request",
    });
    expect(eve.create).not.toHaveBeenCalled();
    expect(services.ensureScope).not.toHaveBeenCalled();
    expect((await startTask(teemiqToken)).status).toBe(202);
  });

  it.each([
    ["an empty loginId", ""],
    ["a numeric loginId", 42],
    ["a null loginId", null],
    ["a loginId over 200 characters", "x".repeat(201)],
  ])("refuses %s with 400 before any lookup", async (_case, loginId) => {
    const response = await createTask(
      new Request("https://assist.example/api/site/tasks", {
        body: JSON.stringify({ loginId, message: "hello" }),
        headers: { authorization: `Bearer ${teemiqToken}` },
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
    expect(services.readSiteLoginPin).not.toHaveBeenCalled();
    expect(eve.create).not.toHaveBeenCalled();
  });

  it("answers 503 JSON when the vault cannot be read", async () => {
    services.readSiteLoginPin.mockRejectedValue(new Error("pool timeout"));

    const response = await createTask(
      siteRequest("/tasks", teemiqToken, {
        loginId: "login-1",
        message: "hello",
      })
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
    expect(eve.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "[site] task login could not be read",
      { error: "Error", site: "teemiq" }
    );
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

  it("leaves the login's sign-in browsers alone at a start it refuses", async () => {
    await startEveryMinute(10);
    vi.setSystemTime(clock + 9 * 60_000);

    const refused = await createTask(
      siteRequest("/tasks", teemiqToken, { loginId: "login-1", message: "hi" })
    );

    expect(refused.status).toBe(429);
    expect(services.closeLeftLoginWriters).not.toHaveBeenCalled();
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

const runningStatus = {
  error: null,
  outcome: null,
  question: null,
  questionId: null,
  reply: null,
  signInOrigin: null,
  status: "running",
};

describe("GET /api/site/tasks/{taskId}", () => {
  it("returns the agent's reply once the task completes, finding nothing without files", async () => {
    eve.read.mockResolvedValue(completedPong());

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: null,
      outcome: "nothing_found",
      question: null,
      questionId: null,
      reply: "pong",
      signInOrigin: null,
      status: "completed",
      kind: "fetch",
      taskId,
    });
    expect(services.findSiteTaskSession).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      taskId
    );
    expect(services.countSiteTaskFiles).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      taskId
    );
    expect(eve.read).toHaveBeenCalledExactlyOnceWith("wrun_1");
    expect(eve.cancel).not.toHaveBeenCalled();
    expect(await grantOfLastClient()).toEqual({
      op: "read",
      session: "wrun_1",
      site: "teemiq",
    });
  });

  it("reports files once the task saved at least one, whatever the agent said", async () => {
    eve.read.mockResolvedValue(completedPong());
    services.countSiteTaskFiles.mockResolvedValue(2);

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    await expect(response.json()).resolves.toMatchObject({
      outcome: "files",
      status: "completed",
    });
  });

  it("counts no files for a task that has not completed", async () => {
    eve.read.mockResolvedValue(runningTask());

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    await expect(response.json()).resolves.toEqual({
      ...runningStatus,
      kind: "fetch",
      taskId,
    });
    expect(services.countSiteTaskFiles).not.toHaveBeenCalled();
  });

  it("names the page where the website asks for the password, as the server recorded it", async () => {
    eve.read.mockResolvedValue(endedWith("sign_in_elsewhere"));
    services.readSiteTaskSignInOrigin.mockResolvedValue(
      "https://auth.vendor.example"
    );

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    await expect(response.json()).resolves.toEqual({
      ...runningStatus,
      error: "sign_in_elsewhere",
      reply: "pong",
      signInOrigin: "https://auth.vendor.example",
      status: "failed",
      kind: "fetch",
      taskId,
    });
    expect(services.readSiteTaskSignInOrigin).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      taskId
    );
  });

  it("reads a sign_in_elsewhere with no recorded page as login_failed", async () => {
    eve.read.mockResolvedValue(endedWith("sign_in_elsewhere"));

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    await expect(response.json()).resolves.toMatchObject({
      error: "login_failed",
      signInOrigin: null,
      status: "failed",
    });
  });

  it("reads no recorded page for any other end", async () => {
    eve.read.mockResolvedValue(endedWith("login_failed"));
    services.readSiteTaskSignInOrigin.mockResolvedValue(
      "https://auth.vendor.example"
    );

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    await expect(response.json()).resolves.toMatchObject({
      error: "login_failed",
      signInOrigin: null,
    });
    expect(services.readSiteTaskSignInOrigin).not.toHaveBeenCalled();
  });

  it("answers 503 when the recorded page cannot be read", async () => {
    eve.read.mockResolvedValue(endedWith("sign_in_elsewhere"));
    services.readSiteTaskSignInOrigin.mockRejectedValue(
      new Error("pool timeout")
    );

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
  });

  it("answers 503 when the task's files cannot be counted", async () => {
    eve.read.mockResolvedValue(completedPong());
    services.countSiteTaskFiles.mockRejectedValue(new Error("pool timeout"));

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
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
    [404, "{}", runningStatus],
    [409, JSON.stringify({ code: "session_not_ready" }), runningStatus],
    [
      410,
      JSON.stringify({ code: "session_expired" }),
      { ...runningStatus, error: "failed", status: "failed" },
    ],
  ])("maps an eve %i to a task status", async (status, body, expected) => {
    eve.read.mockRejectedValue(new ClientError(status, body));

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ...expected,
      kind: "fetch",
      taskId,
    });
  });

  it("reads a task whose run is gone as failed once it is past starting", async () => {
    eve.read.mockRejectedValue(new ClientError(404, "{}"));
    // Just inside the start window, eve's 404 still means the run is starting.
    services.findSiteTaskSession.mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 90_000),
      kind: "fetch",
      sessionId: "wrun_1",
    });
    const starting = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );
    await expect(starting.json()).resolves.toEqual({
      ...runningStatus,
      kind: "fetch",
      taskId,
    });

    // Ten minutes later the run is missing, not starting: a poller must stop.
    services.findSiteTaskSession.mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 10 * 60_000),
      kind: "fetch",
      sessionId: "wrun_1",
    });
    const missing = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual({
      ...runningStatus,
      error: "failed",
      status: "failed",
      kind: "fetch",
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

describe("GET /api/site/tasks/{taskId} past the task's lifetime", () => {
  it.each([
    ["runs", () => runningTask()],
    ["waits for a code", () => awaitingCode()],
  ])(
    "cancels a task that still %s at 45 minutes and reads it timed out",
    async (_case, events) => {
      eve.read.mockResolvedValue(events());
      services.findSiteTaskSession.mockResolvedValue({
        createdAt: new Date(Date.now() - 45 * 60_000),
        kind: "fetch",
        sessionId: "wrun_1",
      });

      const response = await readTask(
        siteRequest(`/tasks/${taskId}`, teemiqToken),
        params(taskId)
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ...runningStatus,
        error: "timed_out",
        status: "failed",
        kind: "fetch",
        taskId,
      });
      expect(eve.cancel).toHaveBeenCalledExactlyOnceWith("wrun_1", "turn_0");
      expect(await grantOfLastClient()).toEqual({
        op: "cancel",
        session: "wrun_1",
        site: "teemiq",
      });
      expect(console.info).toHaveBeenCalledWith(
        "[site] task passed its lifetime and was cancelled",
        { site: "teemiq" }
      );
    }
  );

  it("does not cancel a task one moment inside its lifetime", async () => {
    eve.read.mockResolvedValue(runningTask());
    services.findSiteTaskSession.mockResolvedValue({
      createdAt: new Date(Date.now() - 45 * 60_000 + 1),
      kind: "fetch",
      sessionId: "wrun_1",
    });

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    await expect(response.json()).resolves.toMatchObject({
      status: "running",
    });
    expect(eve.cancel).not.toHaveBeenCalled();
  });

  it("does not cancel a task that ended inside its lifetime", async () => {
    eve.read.mockResolvedValue(completedPong());
    services.findSiteTaskSession.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      kind: "fetch",
      sessionId: "wrun_1",
    });

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    await expect(response.json()).resolves.toMatchObject({
      reply: "pong",
      status: "completed",
    });
    expect(eve.cancel).not.toHaveBeenCalled();
  });

  it("reads timed out without a cancel when eve no longer runs the session", async () => {
    eve.read.mockResolvedValue(runningTask());
    eve.cancel.mockRejectedValue(new SessionNotActiveError());
    services.findSiteTaskSession.mockResolvedValue({
      createdAt: new Date(Date.now() - 50 * 60_000),
      kind: "fetch",
      sessionId: "wrun_1",
    });

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    await expect(response.json()).resolves.toMatchObject({
      error: "timed_out",
      status: "failed",
    });
  });

  it("answers 503 while eve cannot take the cancel, so the read is retried", async () => {
    eve.read.mockResolvedValue(runningTask());
    eve.cancel.mockRejectedValue(new ClientError(500, "{}"));
    services.findSiteTaskSession.mockResolvedValue({
      createdAt: new Date(Date.now() - 50 * 60_000),
      kind: "fetch",
      sessionId: "wrun_1",
    });

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
    expect(console.warn).toHaveBeenCalledWith(
      "[site] task could not be cancelled",
      { error: "http_error", site: "teemiq" }
    );
  });

  it("reads a task eve has not started after 45 minutes as timed out", async () => {
    eve.read.mockRejectedValue(
      new ClientError(409, JSON.stringify({ code: "session_not_ready" }))
    );
    services.findSiteTaskSession.mockResolvedValue({
      createdAt: new Date(Date.now() - 45 * 60_000),
      kind: "fetch",
      sessionId: "wrun_1",
    });

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    await expect(response.json()).resolves.toMatchObject({
      error: "timed_out",
      status: "failed",
    });
    expect(eve.cancel).not.toHaveBeenCalled();
  });
});

describe("GET /api/site/tasks/{taskId} while the worker waits for a code", () => {
  it("awaits input with the worker's question", async () => {
    eve.read.mockResolvedValue(awaitingCode());

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    await expect(response.json()).resolves.toEqual({
      error: null,
      outcome: null,
      question:
        'Enter the one-time code that login.vendor.example just sent by email for the saved login "Vendor".',
      questionId: "interaction-1",
      reply: null,
      signInOrigin: null,
      status: "awaiting-input",
      kind: "fetch",
      taskId,
    });
  });
});

describe("POST /api/site/tasks/{taskId}/input", () => {
  it("seals the code and answers the worker's open question", async () => {
    eve.read.mockResolvedValue(awaitingCode());

    const response = await sendInput(
      inputRequest(teemiqToken, JSON.stringify({ text: " 482913 " })),
      params(taskId)
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ taskId });
    expect(services.findSiteTaskSession).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      taskId
    );
    expect(eve.read).toHaveBeenCalledExactlyOnceWith("wrun_1");
    expect(eve.respond).toHaveBeenCalledOnce();
    const [sessionId, answers] = eve.respond.mock.calls[0] ?? [];
    expect(sessionId).toBe("wrun_1");
    expect(answers?.map(({ interactionId }) => interactionId)).toEqual([
      "interaction-1",
    ]);
    expect(answers?.[0]?.text?.startsWith("assist-code.v1.")).toBe(true);
    expect(JSON.stringify(answers)).not.toContain("482913");
    expect(openSiteCode(authSecret, "wrun_1", answers?.[0]?.text ?? "")).toBe(
      "482913"
    );
    expect(await grantOfLastClient()).toEqual({
      interaction: "interaction-1",
      op: "answer",
      session: "wrun_1",
      site: "teemiq",
    });
  });

  it.each([
    ["has not asked yet", () => runningTask()],
    ["has completed", () => completedPong()],
    ["has already been sent the code", () => awaitingCode({ answered: true })],
    ["waits on a question that is not a code", () => awaitingQuestion()],
    ["has not started in eve yet", () => new ClientError(404, "{}")],
    [
      "has expired in eve",
      () => new ClientError(410, JSON.stringify({ code: "session_expired" })),
    ],
  ])("answers 409 not_waiting for a task that %s", async (_case, state) => {
    const events = state();
    if (events instanceof Error) eve.read.mockRejectedValue(events);
    else eve.read.mockResolvedValue(events);

    const response = await sendInput(
      inputRequest(teemiqToken, JSON.stringify({ text: "482913" })),
      params(taskId)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "not_waiting" });
    expect(eve.respond).not.toHaveBeenCalled();
  });

  it("delivers a code sent twice at once only once", async () => {
    // The question reads as answered once eve has the first answer.
    eve.read.mockImplementation(async () =>
      eve.respond.mock.calls.length > 0
        ? awaitingCode({ answered: true })
        : awaitingCode()
    );
    let accept: (() => void) | undefined;
    eve.respond.mockImplementation(
      async () =>
        new Promise<undefined>((resolve) => {
          accept = () => {
            resolve(undefined);
          };
        })
    );

    const first = sendInput(
      inputRequest(teemiqToken, JSON.stringify({ text: "482913" })),
      params(taskId)
    );
    const second = sendInput(
      inputRequest(teemiqToken, JSON.stringify({ text: "482913" })),
      params(taskId)
    );
    await vi.waitFor(() => {
      expect(accept).toBeDefined();
    });
    accept?.();

    const statuses = (await Promise.all([first, second])).map(
      ({ status }) => status
    );
    expect(statuses).toEqual([202, 409]);
    expect(eve.respond).toHaveBeenCalledOnce();
  });

  it("answers 409 when eve no longer accepts the answer", async () => {
    eve.read.mockResolvedValue(awaitingCode());
    eve.respond.mockRejectedValue(
      new ClientError(409, JSON.stringify({ code: "session_not_active" }))
    );

    const response = await sendInput(
      inputRequest(teemiqToken, JSON.stringify({ text: "482913" })),
      params(taskId)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "not_waiting" });
  });

  it("answers 404 for another site's task, without reading eve", async () => {
    services.findSiteTaskSession.mockResolvedValue(undefined);

    const response = await sendInput(
      inputRequest(agentsToken, JSON.stringify({ text: "482913" })),
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
    expect(eve.respond).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not a task id, without a lookup", async () => {
    const response = await sendInput(
      inputRequest(teemiqToken, JSON.stringify({ text: "482913" }), "wrun_1"),
      params("wrun_1")
    );

    expect(response.status).toBe(404);
    expect(services.findSiteTaskSession).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["an empty code", JSON.stringify({ text: "" })],
    ["a blank code", JSON.stringify({ text: "   " })],
    ["a code over 64 characters", JSON.stringify({ text: "1".repeat(65) })],
    ["a code over two lines", JSON.stringify({ text: "4829\n13" })],
    ["a number", JSON.stringify({ text: 482_913 })],
    ["a message instead of a code", JSON.stringify({ message: "482913" })],
    ["a body that is not JSON", "482913"],
  ])("refuses %s with 400 before any lookup", async (_case, body) => {
    const response = await sendInput(
      inputRequest(teemiqToken, body),
      params(taskId)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
    expect(services.findSiteTaskSession).not.toHaveBeenCalled();
    expect(eve.respond).not.toHaveBeenCalled();
  });

  it("refuses a missing token with 401", async () => {
    const response = await sendInput(
      new Request(`https://assist.example/api/site/tasks/${taskId}/input`, {
        body: JSON.stringify({ text: "482913" }),
        method: "POST",
      }),
      params(taskId)
    );

    expect(response.status).toBe(401);
    expect(services.findSiteTaskSession).not.toHaveBeenCalled();
  });

  it("keeps the code out of every log line, also when delivery fails", async () => {
    eve.read.mockResolvedValue(awaitingCode());
    eve.respond.mockRejectedValueOnce(
      new ClientError(500, JSON.stringify({ error: "could not use 482913" }))
    );

    const failed = await sendInput(
      inputRequest(teemiqToken, JSON.stringify({ text: "482913" })),
      params(taskId)
    );
    const delivered = await sendInput(
      inputRequest(teemiqToken, JSON.stringify({ text: "482913" })),
      params(taskId)
    );

    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({ error: "unavailable" });
    expect(delivered.status).toBe(202);
    expect(console.warn).toHaveBeenCalledWith(
      "[site] task input could not be delivered",
      { error: "http_error", site: "teemiq" }
    );
    expect(console.info).toHaveBeenCalledWith("[site] task input delivered", {
      site: "teemiq",
    });
    const logged = JSON.stringify([
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.info).mock.calls,
    ]);
    expect(logged).not.toContain("482913");
    expect(logged).not.toContain("assist-code");
  });

  it("answers 503 when eve cannot be read", async () => {
    eve.read.mockRejectedValue(new ClientError(500, "{}"));

    const response = await sendInput(
      inputRequest(teemiqToken, JSON.stringify({ text: "482913" })),
      params(taskId)
    );

    expect(response.status).toBe(503);
    expect(eve.respond).not.toHaveBeenCalled();
  });
});

describe("POST /api/site/tasks/{taskId}/input past the task's lifetime", () => {
  it("answers 409 not_waiting for a code question older than the task's lifetime, cancelling the task", async () => {
    eve.read.mockResolvedValue(awaitingCode());
    services.findSiteTaskSession.mockResolvedValue({
      createdAt: new Date(Date.now() - 46 * 60_000),
      kind: "fetch",
      sessionId: "wrun_1",
    });

    const response = await sendInput(
      inputRequest(teemiqToken, JSON.stringify({ text: "482913" })),
      params(taskId)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "not_waiting" });
    expect(eve.respond).not.toHaveBeenCalled();
    expect(eve.cancel).toHaveBeenCalledOnce();
  });

  it("answers 409 not_waiting when eve says the session is no longer active", async () => {
    eve.read.mockResolvedValue(awaitingCode());
    eve.respond.mockRejectedValue(new SessionNotActiveError());

    const response = await sendInput(
      inputRequest(teemiqToken, JSON.stringify({ text: "482913" })),
      params(taskId)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "not_waiting" });
  });
});

const loginTask = (id: string, sessionId: string, minutesAgo = 1) => ({
  createdAt: new Date(Date.now() - minutesAgo * 60_000),
  id,
  sessionId,
});
const openTaskId = "00000000-0000-4000-8000-0000000000aa";
const olderTaskId = "00000000-0000-4000-8000-0000000000bb";

describe("POST /api/site/tasks one task per login", () => {
  it("answers 409 login_busy with the open task of the login, starting nothing", async () => {
    services.listSiteTasksOfLogin.mockResolvedValue([
      loginTask(openTaskId, "wrun_open"),
      loginTask(olderTaskId, "wrun_done", 30),
    ]);
    eve.read.mockImplementation(async (sessionId) =>
      sessionId === "wrun_open" ? awaitingCode() : completedPong()
    );

    const response = await createTask(
      siteRequest("/tasks", teemiqToken, {
        loginId: "login-1",
        message: "Fetch the October invoice.",
      })
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "login_busy",
      taskId: openTaskId,
    });
    expect(services.listSiteTasksOfLogin).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      "login-1",
      5
    );
    expect(eve.create).not.toHaveBeenCalled();
    expect(services.recordSiteTask).not.toHaveBeenCalled();
  });

  it("does not count a busy refusal toward the rate cap", async () => {
    services.listSiteTasksOfLogin.mockResolvedValue([
      loginTask(openTaskId, "wrun_open"),
    ]);
    eve.read.mockResolvedValue(runningTask());

    const refused = await Promise.all(
      Array.from({ length: 11 }, async () =>
        createTask(
          siteRequest("/tasks", teemiqToken, {
            loginId: "login-1",
            message: "hello",
          })
        )
      )
    );

    expect(refused.map(({ status }) => status)).toEqual(
      Array.from({ length: 11 }, () => 409)
    );
    expect((await startTask(teemiqToken)).status).toBe(202);
  });

  it("starts a task once every earlier task of the login has ended", async () => {
    services.listSiteTasksOfLogin.mockResolvedValue([
      loginTask(olderTaskId, "wrun_done", 10),
    ]);
    eve.read.mockResolvedValue(completedPong());

    const response = await createTask(
      siteRequest("/tasks", teemiqToken, { loginId: "login-1", message: "hi" })
    );

    expect(response.status).toBe(202);
    expect(eve.cancel).not.toHaveBeenCalled();
  });

  it("frees the login's sign-in only for a start that goes ahead, before eve starts it", async () => {
    services.ensureScope.mockRejectedValueOnce(new Error("pool timeout"));
    const unavailable = await createTask(
      siteRequest("/tasks", teemiqToken, { loginId: "login-1", message: "hi" })
    );
    expect(unavailable.status).toBe(503);
    expect(services.closeLeftLoginWriters).not.toHaveBeenCalled();

    const started = await createTask(
      siteRequest("/tasks", teemiqToken, { loginId: "login-1", message: "hi" })
    );

    expect(started.status).toBe(202);
    expect(services.closeLeftLoginWriters).toHaveBeenCalledExactlyOnceWith(
      owner,
      "login-1"
    );
    const [closedAt = 0] =
      services.closeLeftLoginWriters.mock.invocationCallOrder;
    expect(closedAt).toBeLessThan(eve.create.mock.invocationCallOrder[0] ?? 0);
  });

  it("cancels an open task of the login past its lifetime, then starts the new one", async () => {
    services.listSiteTasksOfLogin.mockResolvedValue([
      loginTask(olderTaskId, "wrun_stale", 50),
    ]);
    eve.read.mockResolvedValue(runningTask());

    const response = await createTask(
      siteRequest("/tasks", teemiqToken, { loginId: "login-1", message: "hi" })
    );

    expect(response.status).toBe(202);
    expect(eve.cancel).toHaveBeenCalledExactlyOnceWith("wrun_stale", "turn_0");
    expect(eve.create).toHaveBeenCalledOnce();
  });

  it("lets only one of two starts at once for the same login run", async () => {
    // The task the first start records reads as running for the second.
    services.listSiteTasksOfLogin.mockImplementation(async () =>
      services.recordSiteTask.mock.calls.length > 0
        ? [loginTask(taskId, "wrun_1")]
        : []
    );
    eve.read.mockResolvedValue(runningTask());

    const statuses = await Promise.all(
      [0, 1].map(async () =>
        createTask(
          siteRequest("/tasks", teemiqToken, {
            loginId: "login-1",
            message: "hello",
          })
        )
      )
    );

    expect(statuses.map(({ status }) => status)).toEqual([202, 409]);
    await expect(statuses[1]?.json()).resolves.toEqual({
      error: "login_busy",
      taskId,
    });
    expect(eve.create).toHaveBeenCalledOnce();
  });

  it("answers 409 while one task is open although another cannot be read", async () => {
    services.listSiteTasksOfLogin.mockResolvedValue([
      loginTask(openTaskId, "wrun_open"),
      loginTask(olderTaskId, "wrun_unknown", 20),
    ]);
    eve.read.mockImplementation(async (sessionId) => {
      if (sessionId === "wrun_unknown") throw new ClientError(500, "{}");
      return runningTask();
    });

    const response = await createTask(
      siteRequest("/tasks", teemiqToken, { loginId: "login-1", message: "hi" })
    );

    expect(response.status).toBe(409);
  });

  it("answers 503 and starts nothing while the login's tasks cannot be read", async () => {
    services.listSiteTasksOfLogin.mockResolvedValue([
      loginTask(olderTaskId, "wrun_unknown"),
    ]);
    eve.read.mockRejectedValue(new ClientError(500, "{}"));

    const response = await createTask(
      siteRequest("/tasks", teemiqToken, { loginId: "login-1", message: "hi" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
    expect(eve.create).not.toHaveBeenCalled();
  });

  it("answers 503 and starts nothing while the database cannot list them", async () => {
    services.listSiteTasksOfLogin.mockRejectedValue(new Error("pool timeout"));

    const response = await createTask(
      siteRequest("/tasks", teemiqToken, { loginId: "login-1", message: "hi" })
    );

    expect(response.status).toBe(503);
    expect(eve.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "[site] login tasks lookup failed",
      { error: "Error", site: "teemiq" }
    );
  });

  it("checks no other task for a task without a pin", async () => {
    expect((await startTask(teemiqToken)).status).toBe(202);
    expect(services.listSiteTasksOfLogin).not.toHaveBeenCalled();
  });
});

describe("GET /api/site/tasks?loginId", () => {
  it("lists the login's tasks newest first, each with its status and start time", async () => {
    const newer = loginTask(openTaskId, "wrun_open", 2);
    const older = loginTask(olderTaskId, "wrun_done", 30);
    services.listSiteTasksOfLogin.mockResolvedValue([newer, older]);
    eve.read.mockImplementation(async (sessionId) =>
      sessionId === "wrun_open" ? awaitingCode() : completedPong()
    );

    const response = await listTasks(
      siteRequest("/tasks?loginId=login-1", teemiqToken)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      tasks: [
        {
          createdAt: newer.createdAt.toISOString(),
          status: "awaiting-input",
          taskId: openTaskId,
        },
        {
          createdAt: older.createdAt.toISOString(),
          status: "completed",
          taskId: olderTaskId,
        },
      ],
    });
    expect(services.listSiteTasksOfLogin).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      "login-1",
      5
    );
    expect(services.countSiteTaskFiles).not.toHaveBeenCalled();
  });

  it("lists nothing for a login this site has no task of", async () => {
    const response = await listTasks(
      siteRequest("/tasks?loginId=login-other", agentsToken)
    );

    await expect(response.json()).resolves.toEqual({ tasks: [] });
    expect(services.listSiteTasksOfLogin).toHaveBeenCalledExactlyOnceWith(
      "agents",
      owner,
      "login-other",
      5
    );
  });

  it("cancels a listed task past its lifetime and lists it as failed", async () => {
    services.listSiteTasksOfLogin.mockResolvedValue([
      loginTask(olderTaskId, "wrun_stale", 50),
    ]);
    eve.read.mockResolvedValue(runningTask());

    const response = await listTasks(
      siteRequest("/tasks?loginId=login-1", teemiqToken)
    );

    await expect(response.json()).resolves.toMatchObject({
      tasks: [{ status: "failed", taskId: olderTaskId }],
    });
    expect(eve.cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["no loginId", "/tasks"],
    ["an empty loginId", "/tasks?loginId="],
    ["a loginId over 200 characters", `/tasks?loginId=${"x".repeat(201)}`],
  ])("refuses %s with 400 before any lookup", async (_case, path) => {
    const response = await listTasks(siteRequest(path, teemiqToken));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
    expect(services.listSiteTasksOfLogin).not.toHaveBeenCalled();
  });

  it("answers 503 while one of the tasks cannot be read", async () => {
    services.listSiteTasksOfLogin.mockResolvedValue([
      loginTask(olderTaskId, "wrun_unknown"),
    ]);
    eve.read.mockRejectedValue(new ClientError(500, "{}"));

    const response = await listTasks(
      siteRequest("/tasks?loginId=login-1", teemiqToken)
    );

    expect(response.status).toBe(503);
  });

  it("refuses a wrong token with 401", async () => {
    const response = await listTasks(
      siteRequest(
        "/tasks?loginId=login-1",
        "not-a-configured-site-token-0123456789"
      )
    );

    expect(response.status).toBe(401);
    expect(services.listSiteTasksOfLogin).not.toHaveBeenCalled();
  });
});

describe("POST /api/site/tasks/{taskId}/cancel", () => {
  it.each([
    ["runs", () => runningTask()],
    ["waits for a code", () => awaitingCode()],
  ])("cancels the site's turn of a task that %s", async (_case, events) => {
    eve.read.mockResolvedValue(events());

    const response = await cancelTask(
      cancelRequest(teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ taskId });
    expect(eve.cancel).toHaveBeenCalledExactlyOnceWith("wrun_1", "turn_0");
    expect(await grantOfLastClient()).toEqual({
      op: "cancel",
      session: "wrun_1",
      site: "teemiq",
    });
    expect(console.info).toHaveBeenCalledWith("[site] task cancelled", {
      site: "teemiq",
    });
  });

  it("reads the task cancelled once eve has stopped its turn", async () => {
    eve.read.mockResolvedValue(cancelledTask());

    const response = await readTask(
      siteRequest(`/tasks/${taskId}`, teemiqToken),
      params(taskId)
    );

    await expect(response.json()).resolves.toMatchObject({
      error: "cancelled",
      status: "failed",
    });
  });

  it.each([
    ["has completed", () => completedPong()],
    ["was cancelled before", () => cancelledTask()],
  ])(
    "answers 202 and leaves a task that %s as it is",
    async (_case, events) => {
      eve.read.mockResolvedValue(events());

      const response = await cancelTask(
        cancelRequest(teemiqToken),
        params(taskId)
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ taskId });
      expect(eve.cancel).not.toHaveBeenCalled();
    }
  );

  it("answers 202 when eve no longer runs the session", async () => {
    eve.read.mockResolvedValue(runningTask());
    eve.cancel.mockRejectedValue(new SessionNotActiveError());

    const response = await cancelTask(
      cancelRequest(teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(202);
  });

  it.each([
    ["has no turn yet", () => eventsOf([])],
    ["eve has not started", () => new ClientError(404, "{}")],
  ])(
    "answers 503 for a task whose run %s, so the site retries",
    async (_case, state) => {
      const events = state();
      if (events instanceof Error) eve.read.mockRejectedValue(events);
      else eve.read.mockResolvedValue(events);

      const response = await cancelTask(
        cancelRequest(teemiqToken),
        params(taskId)
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "unavailable" });
      expect(eve.cancel).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["eve cannot take the cancel", new ClientError(500, "{}")],
    [
      "the session is still starting",
      new SessionNotActiveError({ retryable: true }),
    ],
  ])("answers 503 when %s", async (_case, error) => {
    eve.read.mockResolvedValue(runningTask());
    eve.cancel.mockRejectedValue(error);

    const response = await cancelTask(
      cancelRequest(teemiqToken),
      params(taskId)
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
  });

  it("answers 404 for another site's task, without reading eve", async () => {
    services.findSiteTaskSession.mockResolvedValue(undefined);

    const response = await cancelTask(
      cancelRequest(agentsToken),
      params(taskId)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
    expect(eve.read).not.toHaveBeenCalled();
    expect(eve.cancel).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not a task id, without a lookup", async () => {
    const response = await cancelTask(
      cancelRequest(teemiqToken, "wrun_1"),
      params("wrun_1")
    );

    expect(response.status).toBe(404);
    expect(services.findSiteTaskSession).not.toHaveBeenCalled();
  });

  it("refuses a missing token with 401", async () => {
    const response = await cancelTask(
      new Request(`https://assist.example/api/site/tasks/${taskId}/cancel`, {
        method: "POST",
      }),
      params(taskId)
    );

    expect(response.status).toBe(401);
    expect(services.findSiteTaskSession).not.toHaveBeenCalled();
  });
});

function cancelRequest(token: string, id = taskId) {
  return new Request(`https://assist.example/api/site/tasks/${id}/cancel`, {
    headers: { authorization: `Bearer ${token}` },
    method: "POST",
  });
}

function cancelledTask() {
  return eventsOf([
    turnStartedFacts,
    [
      {
        data: { outcome: "cancelled", turnId: "turn_0" },
        scope: { turnId: "turn_0" },
        type: "turn.settled",
      },
    ],
  ]);
}

function inputRequest(token: string, body: string | undefined, id = taskId) {
  const init: RequestInit = {
    headers: { authorization: `Bearer ${token}` },
    method: "POST",
  };
  if (body !== undefined) init.body = body;
  return new Request(`https://assist.example/api/site/tasks/${id}/input`, init);
}

function siteRequest(
  path: string,
  token: string,
  body?: { kind?: string; loginId?: string; message: string }
) {
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

const authSecret = "test-auth-secret-0123456789abcdefghijklmnop";

async function grantOfLastClient() {
  const bearer = eve.bearers.at(-1);
  if (!bearer) throw new Error("No eve client was created.");
  return verifySiteCredential(authSecret, await bearer());
}

const turnStartedFacts: Fact[] = [
  {
    data: { cause: { deliveryId: "d-1" }, follows: null, turnId: "turn_0" },
    type: "turn.started",
  },
  {
    data: { owner: { turnId: "turn_0" }, runId: "run-1" },
    scope: { runId: "run-1", turnId: "turn_0" },
    type: "model.requested",
  },
];

function runningTask() {
  return eventsOf([turnStartedFacts]);
}

function questionFacts(
  request: Extract<Fact, { type: "interaction.opened" }>["data"]["request"]
): Fact[] {
  return [
    {
      data: {
        interactionId: "interaction-1",
        request,
        subject: { turnId: "turn_0" },
      },
      scope: { turnId: "turn_0" },
      type: "interaction.opened",
    },
    {
      data: {
        awaiting: [{ interactionId: "interaction-1" }],
        turnId: "turn_0",
      },
      scope: { turnId: "turn_0" },
      type: "turn.paused",
    },
  ];
}

// The browser worker's code question, relayed to the root session.
function awaitingCode({ answered = false } = {}) {
  return eventsOf([
    turnStartedFacts,
    questionFacts({
      allowFreeform: true,
      display: "text",
      kind: "question",
      prompt:
        'Enter the one-time code that login.vendor.example just sent by email for the saved login "Vendor".',
      title: "One-time code",
    }),
    ...(answered
      ? [
          [
            {
              data: {
                deliveryId: "d-2",
                interactionId: "interaction-1",
                responseId: "response-1",
                value: { text: "assist-code.v1.sealed" },
              },
              type: "response.submitted",
            } satisfies Fact,
          ],
        ]
      : []),
  ]);
}

function awaitingQuestion() {
  return eventsOf([
    turnStartedFacts,
    questionFacts({ kind: "question", prompt: "Which store should I check?" }),
  ]);
}

// A task whose agent replied pong and then ended it with this result.
function endedWith(result: string) {
  const [started = [], sent = [], settled = []] = pongLines();
  return eventsOf([
    started,
    sent,
    [
      {
        data: {
          callId: "call-2",
          capability: { kind: "tool", name: "end_site_task" },
          input: { result },
          owner: { runId: "run-1" },
        },
        scope: { runId: "run-1", turnId: "turn_0" },
        type: "call.requested",
      },
      {
        data: { callId: "call-2", outcome: "completed", output: { result } },
        scope: { runId: "run-1", turnId: "turn_0" },
        type: "call.settled",
      },
    ],
    settled,
  ]);
}

function completedPong() {
  return eventsOf(pongLines());
}

function toolCall(
  callId: string,
  name: string,
  output: Record<string, string>
): Fact[] {
  return [
    {
      data: {
        callId,
        capability: { kind: "tool", name },
        input: output,
        owner: { runId: "run-1" },
      },
      scope: { runId: "run-1", turnId: "turn_0" },
      type: "call.requested",
    },
    {
      data: { callId, outcome: "completed", output },
      scope: { runId: "run-1", turnId: "turn_0" },
      type: "call.settled",
    },
  ];
}

function lookEnded(result: string) {
  const [started = [], , settled = []] = pongLines();
  return eventsOf([
    started,
    toolCall("call-1", "send_message", {
      kind: "message",
      text: "2026-11-03 INV-1 20.00 USD invoice",
    }),
    toolCall("call-2", "end_site_task", { result }),
    settled,
  ]);
}

function pongLines(): Fact[][] {
  return [
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
  ];
}
