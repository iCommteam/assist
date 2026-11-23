import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type * as EveClient from "eve/client";
import type { Fact, ReceivedEvent } from "eve/events";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  vi.stubEnv("ASSIST_ALLOWED_EMAILS", "owner@example.test");
});

const eve = vi.hoisted(() => ({
  read: vi.fn<(sessionId: string) => Promise<ReceivedEvent[]>>(),
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
    };
  }
  return { ...original, Client: FakeClient };
});

import * as Database from "@db";
import * as schema from "@db/schema";
import { ensureScope } from "@db/services/scope";
import { recordSiteTask, saveSiteTaskFile } from "@db/services/sites";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { eventsOf } from "@tests/helpers/session-view";

const { GET: listFiles } =
  await import("@app/api/site/tasks/[taskId]/files/route");
const { GET: downloadFile } =
  await import("@app/api/site/tasks/[taskId]/files/[fileId]/route");
const { GET: readTask } = await import("@app/api/site/tasks/[taskId]/route");

const client = new PGlite();
const database = drizzle(client, { schema });
// SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real routes, schema and services with an isolated PostgreSQL-compatible test database.
const testDatabase = database as never;
const owner = accessScopeForUser("better-auth:owner-id");
const teemiqToken = "teemiq-test-token-0123456789abcdef";
const agentsToken = "agents-test-token-0123456789abcdef";
const siteVariables = [
  ["ASSIST_SITE_TOKEN_TEEMIQ", teemiqToken],
  ["ASSIST_SITE_OWNER_TEEMIQ", "owner@example.test"],
  ["ASSIST_SITE_TOKEN_AGENTS", agentsToken],
  ["ASSIST_SITE_OWNER_AGENTS", "owner@example.test"],
] as const;
const unknownId = "00000000-0000-4000-8000-0000000000ff";
const invoiceText = "%PDF-1.7 the October invoice of Vendor";
const invoice = Buffer.from(invoiceText);
const receipt = Buffer.from("%PDF-1.4 the October receipt of Vendor");

const answers: Response[] = [];

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  vi.spyOn(Database, "db", "get").mockReturnValue(testDatabase);
  await database.insert(schema.user).values({
    email: "owner@example.test",
    id: "owner-id",
    name: "Owner",
    twoFactorEnabled: true,
  });
  await ensureScope(owner);
}, 30_000);

beforeEach(async () => {
  vi.clearAllMocks();
  answers.length = 0;
  for (const [name, value] of siteVariables) vi.stubEnv(name, value);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  eve.read.mockResolvedValue(completedTask());
  await database.delete(schema.siteTasks);
});

// Every answer of every test is no-store, and no log line carries a file's
// contents.
afterEach(() => {
  for (const [name] of siteVariables) vi.stubEnv(name, "");
  if (answers.some((r) => r.headers.get("cache-control") !== "no-store")) {
    throw new Error("A site answer was not no-store.");
  }
  const logs = JSON.stringify([
    vi.mocked(console.warn).mock.calls,
    vi.mocked(console.info).mock.calls,
  ]);
  if (logs.includes("October")) {
    throw new Error("A file's contents reached a log line.");
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("GET /api/site/tasks/{taskId}/files", () => {
  it("lists the PDFs the site's task saved, oldest first, without their bytes", async () => {
    const { taskId, files } = await taskWithFiles("wrun_list", [
      ["Invoice 2026-10.pdf", invoice],
      ["Receipt 2026-10.pdf", receipt],
    ]);
    await database
      .update(schema.taskFiles)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.taskFiles.id, files[1] ?? ""));

    const response = await call(listFiles(request(teemiqToken), task(taskId)));

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const created = await createdAtOf(taskId);
    expect(created.get(files[1] ?? "")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
    );
    expect(body).toEqual({
      files: [
        {
          byteSize: receipt.byteLength,
          createdAt: created.get(files[1] ?? ""),
          fileId: files[1],
          filename: "Receipt 2026-10.pdf",
          mediaType: "application/pdf",
          sha256: sha256Of(receipt),
        },
        {
          byteSize: invoice.byteLength,
          createdAt: created.get(files[0] ?? ""),
          fileId: files[0],
          filename: "Invoice 2026-10.pdf",
          mediaType: "application/pdf",
          sha256: sha256Of(invoice),
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("October invoice");
  });

  it("answers an empty list for a task that saved nothing", async () => {
    const { taskId } = await taskWithFiles("wrun_empty", []);

    const response = await call(listFiles(request(teemiqToken), task(taskId)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ files: [] });
  });

  it("answers 404 for another site's task, an unknown task and a malformed id", async () => {
    const { taskId } = await taskWithFiles("wrun_scoped", [["a.pdf", invoice]]);

    const responses = await Promise.all(
      [
        listFiles(request(agentsToken), task(taskId)),
        listFiles(request(teemiqToken), task(unknownId)),
        listFiles(request(teemiqToken), task("not-a-task")),
      ].map(call)
    );

    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404]);
    for (const response of responses) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each answer is read on its own.
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
    }
  });

  it("stops listing a file after its seven days, and purges it", async () => {
    const { taskId, files } = await taskWithFiles("wrun_expired", [
      ["old.pdf", invoice],
      ["new.pdf", receipt],
    ]);
    await database
      .update(schema.taskFiles)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.taskFiles.id, files[0] ?? ""));

    const response = await call(listFiles(request(teemiqToken), task(taskId)));

    await expect(response.json()).resolves.toMatchObject({
      files: [{ filename: "new.pdf" }],
    });
    await expect(storedFileIds(taskId)).resolves.toEqual([files[1]]);
  });
});

describe("GET /api/site/tasks/{taskId}/files/{fileId}", () => {
  it("answers the exact bytes as a PDF with their length and hash", async () => {
    const { taskId, files } = await taskWithFiles("wrun_bytes", [
      ["Invoice.pdf", invoice],
    ]);

    const response = await call(
      downloadFile(request(teemiqToken), file(taskId, files[0] ?? ""))
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe(
      String(invoice.byteLength)
    );
    expect(response.headers.get("x-content-sha256")).toBe(sha256Of(invoice));
    expect(response.headers.get("content-disposition")).toBe("attachment");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.equals(invoice)).toBe(true);
  });

  it("answers 404 for another site's task, another task's file, and unknown or malformed ids", async () => {
    const mine = await taskWithFiles("wrun_mine", [["mine.pdf", invoice]]);
    const sibling = await taskWithFiles("wrun_sibling", [
      ["sibling.pdf", receipt],
    ]);
    const fileId = mine.files[0] ?? "";

    const responses = await Promise.all(
      [
        downloadFile(request(agentsToken), file(mine.taskId, fileId)),
        downloadFile(request(teemiqToken), file(sibling.taskId, fileId)),
        downloadFile(request(teemiqToken), file(mine.taskId, unknownId)),
        downloadFile(request(teemiqToken), file(unknownId, fileId)),
        downloadFile(request(teemiqToken), file(mine.taskId, "x")),
        downloadFile(request(teemiqToken), file("x", fileId)),
      ].map(call)
    );

    expect(responses.map(({ status }) => status)).toEqual([
      404, 404, 404, 404, 404, 404,
    ]);
    const bodies = await Promise.all(
      responses.map(async (response) => response.text())
    );
    for (const body of bodies) {
      expect(JSON.parse(body)).toEqual({ error: "not_found" });
    }
  });

  it("answers 404 once the file's seven days have passed, and purges it", async () => {
    const { taskId, files } = await taskWithFiles("wrun_gone", [
      ["gone.pdf", invoice],
    ]);
    const fileId = files[0] ?? "";
    await database
      .update(schema.taskFiles)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.taskFiles.id, fileId));

    const response = await call(
      downloadFile(request(teemiqToken), file(taskId, fileId))
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
    await expect(storedFileIds(taskId)).resolves.toEqual([]);
  });
});

describe("site file authentication", () => {
  it("refuses a missing token with 401 and a site whose owner is not ready with 403", async () => {
    const { taskId, files } = await taskWithFiles("wrun_auth", [
      ["a.pdf", invoice],
    ]);
    const fileId = files[0] ?? "";
    const unsigned = new Request("https://assist.example/api/site/tasks/x");

    const missing = await Promise.all(
      [
        listFiles(unsigned, task(taskId)),
        downloadFile(unsigned, file(taskId, fileId)),
      ].map(call)
    );
    vi.stubEnv("ASSIST_SITE_OWNER_TEEMIQ", "nobody@example.test");
    const forbidden = await Promise.all(
      [
        listFiles(request(teemiqToken), task(taskId)),
        downloadFile(request(teemiqToken), file(taskId, fileId)),
      ].map(call)
    );

    expect(missing.map(({ status }) => status)).toEqual([401, 401]);
    expect(forbidden.map(({ status }) => status)).toEqual([403, 403]);
    const bodies = await Promise.all(
      [...missing, ...forbidden].map(async (response) => response.text())
    );
    expect(bodies).toEqual([
      '{"error":"unauthorized"}',
      '{"error":"unauthorized"}',
      '{"error":"forbidden"}',
      '{"error":"forbidden"}',
    ]);
  });
});

describe("a completed task's outcome", () => {
  it("reads files while the task keeps a saved file, and nothing_found otherwise", async () => {
    const { taskId } = await taskWithFiles("wrun_outcome", []);
    const outcome = async () => {
      const response = await call(readTask(request(teemiqToken), task(taskId)));
      const body: unknown = await response.json();
      return body;
    };

    await expect(outcome()).resolves.toMatchObject({
      error: null,
      outcome: "nothing_found",
      status: "completed",
    });
    const saved = await saveSiteTaskFile("teemiq", owner, "wrun_outcome", {
      content: invoice,
      filename: "a.pdf",
      sha256: sha256Of(invoice),
    });
    await expect(outcome()).resolves.toMatchObject({
      outcome: "files",
      status: "completed",
    });

    // Past its seven days the file is gone, so nothing is there to collect.
    if (!saved.ok) throw new Error("The file was not saved.");
    await database
      .update(schema.taskFiles)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.taskFiles.id, saved.file.fileId));
    await expect(outcome()).resolves.toMatchObject({
      outcome: "nothing_found",
      status: "completed",
    });
  });
});

async function call(answer: Promise<Response>) {
  const response = await answer;
  answers.push(response);
  return response;
}

async function taskWithFiles(
  sessionId: string,
  files: readonly (readonly [string, Buffer])[]
) {
  const taskId = await recordSiteTask("teemiq", owner, sessionId, "login-1");
  const ids: string[] = [];
  for (const [filename, content] of files) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Saved in order, as a worker does.
    const saved = await saveSiteTaskFile("teemiq", owner, sessionId, {
      content,
      filename,
      sha256: sha256Of(content),
    });
    if (!saved.ok) throw new Error("The file was not saved.");
    ids.push(saved.file.fileId);
  }
  return { files: ids, taskId };
}

async function createdAtOf(taskId: string) {
  const rows = await database
    .select({ createdAt: schema.taskFiles.createdAt, id: schema.taskFiles.id })
    .from(schema.taskFiles)
    .where(eq(schema.taskFiles.taskId, taskId));
  return new Map(
    rows.map(({ createdAt, id }) => [id, createdAt.toISOString()])
  );
}

async function storedFileIds(taskId: string) {
  const rows = await database
    .select({ id: schema.taskFiles.id })
    .from(schema.taskFiles)
    .where(eq(schema.taskFiles.taskId, taskId));
  return rows.map(({ id }) => id);
}

function sha256Of(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function request(token: string) {
  return new Request("https://assist.example/api/site/tasks/x/files", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function task(taskId: string) {
  return { params: Promise.resolve({ taskId }) };
}

function file(taskId: string, fileId: string) {
  return { params: Promise.resolve({ fileId, taskId }) };
}

const turnStarted: Fact = {
  data: { cause: { deliveryId: "d-1" }, follows: null, turnId: "turn_0" },
  type: "turn.started",
};

function completedTask() {
  return eventsOf(
    [
      [turnStarted],
      [
        {
          data: { outcome: "completed", turnId: "turn_0" },
          scope: { turnId: "turn_0" },
          type: "turn.settled",
        },
      ],
    ],
    new Date().toISOString()
  );
}
