import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  vi.stubEnv(
    "ASSIST_ALLOWED_EMAILS",
    "owner@example.test,plain@example.test,nobody@example.test"
  );
});

import * as Database from "@db";
import * as schema from "@db/schema";
import { ensureScope } from "@db/services/scope";
import {
  countSiteTaskFiles,
  findSiteTaskSession,
  isAnySiteTaskSession,
  isSiteTaskSession,
  listSiteTaskFiles,
  listSiteTasksOfLogin,
  purgeExpiredTaskFiles,
  readSiteTaskFile,
  readSiteTaskSignInOrigin,
  recordSiteTask,
  recordSiteTaskSignInOrigin,
  resolveSiteOwner,
  saveSiteTaskFile,
  siteTaskFileRoom,
} from "@db/services/sites";
import {
  deleteSiteLogin,
  isSiteLoginLabelTaken,
  listSiteLogins,
  listVaultItems,
  readSiteLoginPin,
  readVaultSecret,
  saveSiteLogin,
  saveVaultItem,
} from "@db/services/vault";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { serializeLoginVaultPayload } from "@shared/vault/schema";

const client = new PGlite();
const database = drizzle(client, { schema });
const owner = accessScopeForUser("better-auth:owner-id");
const other = accessScopeForUser("better-auth:other-id");

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
  await database.insert(schema.user).values([
    {
      email: "Owner@Example.test",
      id: "owner-id",
      name: "Owner",
      twoFactorEnabled: true,
    },
    {
      email: "plain@example.test",
      id: "plain-id",
      name: "Plain",
      twoFactorEnabled: false,
    },
  ]);
}, 20_000);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubEnv("ASSIST_SITE_TOKEN_TEEMIQ", "teemiq-test-token-0123456789abcdef");
  vi.stubEnv("ASSIST_SITE_OWNER_TEEMIQ", "owner@example.test");
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("site owner", () => {
  it("acts in the personal workspace of an enrolled, listed owner", async () => {
    await expect(resolveSiteOwner("teemiq")).resolves.toEqual({
      email: "owner@example.test",
      ok: true,
      scope: owner,
    });
  });

  it.each([
    ["", "owner not configured"],
    ["outsider@example.test", "owner not on the team list"],
    ["nobody@example.test", "owner has no account"],
    ["plain@example.test", "owner has no authenticator"],
  ])("refuses the site when its owner is %j", async (email, reason) => {
    vi.stubEnv("ASSIST_SITE_OWNER_TEEMIQ", email);

    await expect(resolveSiteOwner("teemiq")).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it("refuses a site that is not configured", async () => {
    await expect(resolveSiteOwner("agents")).resolves.toEqual({
      ok: false,
      reason: "owner not configured",
    });
  });
});

describe("site tasks", () => {
  it("lets a site read only the tasks it created in its owner's workspace", async () => {
    await ensureScope(owner);
    await ensureScope(other);
    const before = Date.now();
    const taskId = await recordSiteTask(
      "teemiq",
      owner,
      "wrun_teemiq",
      undefined
    );

    expect(taskId).toMatch(/^[0-9a-f-]{36}$/u);
    const task = await findSiteTaskSession("teemiq", owner, taskId);
    expect(task?.sessionId).toBe("wrun_teemiq");
    // The task route times eve's "not found" from this creation time.
    expect(task?.createdAt).toBeInstanceOf(Date);
    expect(task?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(task?.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    await expect(
      findSiteTaskSession("agents", owner, taskId)
    ).resolves.toBeUndefined();
    await expect(
      findSiteTaskSession("teemiq", other, taskId)
    ).resolves.toBeUndefined();
    await expect(
      findSiteTaskSession(
        "teemiq",
        owner,
        "00000000-0000-4000-8000-000000000000"
      )
    ).resolves.toBeUndefined();

    await expect(
      isSiteTaskSession("teemiq", owner, "wrun_teemiq")
    ).resolves.toBe(true);
    await expect(
      isSiteTaskSession("agents", owner, "wrun_teemiq")
    ).resolves.toBe(false);
    await expect(
      isSiteTaskSession("teemiq", other, "wrun_teemiq")
    ).resolves.toBe(false);

    // The chat asks whether a session is any site's task in its workspace.
    await expect(isAnySiteTaskSession(owner, "wrun_teemiq")).resolves.toBe(
      true
    );
    await expect(isAnySiteTaskSession(other, "wrun_teemiq")).resolves.toBe(
      false
    );
    await expect(isAnySiteTaskSession(owner, "wrun_chat")).resolves.toBe(false);
  });

  it("records one site per session", async () => {
    await ensureScope(owner);
    await recordSiteTask("teemiq", owner, "wrun_once", undefined);

    await expect(
      recordSiteTask("agents", owner, "wrun_once", undefined)
    ).rejects.toThrow("Failed query");
  });
});

describe("site tasks of a login", () => {
  it("lists one site's newest tasks pinned to a login, newest first", async () => {
    await ensureScope(owner);
    await ensureScope(other);
    const now = Date.now();
    const pinned = async (
      site: string,
      scope: typeof owner,
      sessionId: string,
      loginId: string | undefined,
      minutesAgo: number
    ) => {
      const id = await recordSiteTask(site, scope, sessionId, loginId);
      await database
        .update(schema.siteTasks)
        .set({ createdAt: new Date(now - minutesAgo * 60_000) })
        .where(eq(schema.siteTasks.id, id));
      return id;
    };
    const older = await pinned("teemiq", owner, "wrun_l1", "login-a", 20);
    const newer = await pinned("teemiq", owner, "wrun_l2", "login-a", 5);
    const oldest = await pinned("teemiq", owner, "wrun_l3", "login-a", 50);
    await pinned("teemiq", owner, "wrun_l4", "login-b", 5);
    await pinned("teemiq", owner, "wrun_l5", undefined, 5);
    await pinned("agents", owner, "wrun_l6", "login-a", 5);
    await pinned("teemiq", other, "wrun_l7", "login-a", 5);

    const tasks = await listSiteTasksOfLogin("teemiq", owner, "login-a", 5);
    const newest = await listSiteTasksOfLogin("teemiq", owner, "login-a", 2);

    expect(tasks.map(({ id }) => id)).toEqual([newer, older, oldest]);
    expect(tasks.map(({ sessionId }) => sessionId)).toEqual([
      "wrun_l2",
      "wrun_l1",
      "wrun_l3",
    ]);
    expect(tasks[0]?.createdAt).toBeInstanceOf(Date);
    expect(newest.map(({ id }) => id)).toEqual([newer, older]);
  });
});

describe("site task sign-in page", () => {
  it("records the latest page for this site's open task in this workspace only", async () => {
    await ensureScope(owner);
    await ensureScope(other);
    const task = await recordSiteTask("teemiq", owner, "wrun_p1", "login-p");
    const otherTask = await recordSiteTask("teemiq", other, "wrun_p2", "x");

    await expect(readSiteTaskSignInOrigin("teemiq", owner, task)).resolves.toBe(
      null
    );
    await expect(
      Promise.all([
        recordSiteTaskSignInOrigin(
          "agents",
          owner,
          "wrun_p1",
          "https://a.example"
        ),
        recordSiteTaskSignInOrigin(
          "teemiq",
          other,
          "wrun_p1",
          "https://a.example"
        ),
        recordSiteTaskSignInOrigin(
          "teemiq",
          owner,
          "wrun_none",
          "https://a.example"
        ),
      ])
    ).resolves.toEqual([false, false, false]);
    await expect(readSiteTaskSignInOrigin("teemiq", owner, task)).resolves.toBe(
      null
    );

    await expect(
      recordSiteTaskSignInOrigin(
        "teemiq",
        owner,
        "wrun_p1",
        "https://auth.vendor.example"
      )
    ).resolves.toBe(true);
    await expect(
      recordSiteTaskSignInOrigin(
        "teemiq",
        owner,
        "wrun_p1",
        "https://login.vendor.example"
      )
    ).resolves.toBe(true);
    await expect(readSiteTaskSignInOrigin("teemiq", owner, task)).resolves.toBe(
      "https://login.vendor.example"
    );
    await expect(
      Promise.all([
        readSiteTaskSignInOrigin("agents", owner, task),
        readSiteTaskSignInOrigin("teemiq", other, task),
        readSiteTaskSignInOrigin("teemiq", other, otherTask),
      ])
    ).resolves.toEqual([null, null, null]);

    // Past its 45 minutes a task records nothing more.
    await database
      .update(schema.siteTasks)
      .set({ createdAt: new Date(Date.now() - 45 * 60_000 - 1000) })
      .where(eq(schema.siteTasks.id, task));
    await expect(
      recordSiteTaskSignInOrigin(
        "teemiq",
        owner,
        "wrun_p1",
        "https://late.vendor.example"
      )
    ).resolves.toBe(false);
    await expect(readSiteTaskSignInOrigin("teemiq", owner, task)).resolves.toBe(
      "https://login.vendor.example"
    );
  });
});

describe("site task files", () => {
  it("counts only the files this site's task saved in this workspace", async () => {
    await ensureScope(owner);
    await ensureScope(other);
    const task = await recordSiteTask("teemiq", owner, "wrun_f1", "login-f");
    const otherTask = await recordSiteTask(
      "teemiq",
      owner,
      "wrun_f2",
      "login-f"
    );
    const pdf = new TextEncoder().encode("%PDF-1.7 test");
    const file = (taskId: string, site: string, workspaceId: string) => ({
      byteSize: pdf.byteLength,
      content: pdf,
      filename: "invoice.pdf",
      mediaType: "application/pdf" as const,
      sha256: "a".repeat(64),
      site,
      taskId,
      workspaceId,
    });
    await database
      .insert(schema.taskFiles)
      .values([
        file(task, "teemiq", owner.workspaceId),
        file(task, "teemiq", owner.workspaceId),
        file(otherTask, "teemiq", owner.workspaceId),
      ]);

    await expect(countSiteTaskFiles("teemiq", owner, task)).resolves.toBe(2);
    await expect(countSiteTaskFiles("agents", owner, task)).resolves.toBe(0);
    await expect(countSiteTaskFiles("teemiq", other, task)).resolves.toBe(0);
    const empty = await recordSiteTask("teemiq", owner, "wrun_f3", "login-f");
    await expect(countSiteTaskFiles("teemiq", owner, empty)).resolves.toBe(0);

    // An expired file no longer counts, even before it is purged.
    await database
      .update(schema.taskFiles)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.taskFiles.taskId, task));
    await expect(countSiteTaskFiles("teemiq", owner, task)).resolves.toBe(0);
    await database
      .delete(schema.taskFiles)
      .where(eq(schema.taskFiles.taskId, task));
  });
});

function pdfOf(text: string) {
  return Buffer.from(`%PDF-1.7 ${text}`);
}

function saved(content: Buffer, filename = "invoice.pdf") {
  return {
    content,
    filename,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

describe("saving site task files", () => {
  beforeEach(async () => {
    await ensureScope(owner);
    await ensureScope(other);
  });

  it("keeps a task's PDF for seven days, once per distinct file", async () => {
    const task = await recordSiteTask("teemiq", owner, "wrun_s1", "login-s");
    const first = pdfOf("first");

    await expect(siteTaskFileRoom("teemiq", owner, "wrun_s1")).resolves.toBe(
      "open"
    );
    const saving = await saveSiteTaskFile(
      "teemiq",
      owner,
      "wrun_s1",
      saved(first, "October.pdf")
    );
    if (!saving.ok) throw new Error("The file was not saved.");
    expect(saving.alreadySaved).toBe(false);
    expect(saving.file).toMatchObject({
      byteSize: first.byteLength,
      filename: "October.pdf",
    });
    expect(saving.file.fileId).toMatch(/^[0-9a-f-]{36}$/u);
    const [row] = await database
      .select()
      .from(schema.taskFiles)
      .where(eq(schema.taskFiles.taskId, task));
    expect(Buffer.from(row?.content ?? []).equals(first)).toBe(true);
    expect(row).toMatchObject({
      mediaType: "application/pdf",
      site: "teemiq",
      workspaceId: owner.workspaceId,
    });
    expect(
      (row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)
    ).toBe(7 * 24 * 60 * 60_000);

    // The same bytes under another name are the file already kept.
    await expect(
      saveSiteTaskFile("teemiq", owner, "wrun_s1", saved(first, "Copy.pdf"))
    ).resolves.toEqual({ ...saving, alreadySaved: true });
    await expect(countSiteTaskFiles("teemiq", owner, task)).resolves.toBe(1);
  });

  it("keeps at most ten files per task, also when saves race", async () => {
    const task = await recordSiteTask("teemiq", owner, "wrun_s2", "login-s");
    for (const index of Array.from({ length: 9 }, (_, value) => value)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Saved one after another, as a worker does.
      await saveSiteTaskFile(
        "teemiq",
        owner,
        "wrun_s2",
        saved(pdfOf(String(index)))
      );
    }

    const racing = await Promise.all([
      saveSiteTaskFile("teemiq", owner, "wrun_s2", saved(pdfOf("tenth"))),
      saveSiteTaskFile("teemiq", owner, "wrun_s2", saved(pdfOf("eleventh"))),
    ]);
    expect(racing.filter(({ ok }) => ok)).toHaveLength(1);
    expect(racing).toContainEqual({ ok: false, reason: "full" });
    await expect(countSiteTaskFiles("teemiq", owner, task)).resolves.toBe(10);
    await expect(siteTaskFileRoom("teemiq", owner, "wrun_s2")).resolves.toBe(
      "full"
    );
    // A file it already keeps is still reported as kept.
    await expect(
      saveSiteTaskFile("teemiq", owner, "wrun_s2", saved(pdfOf("0")))
    ).resolves.toMatchObject({ alreadySaved: true, ok: true });

    const twins = await recordSiteTask("teemiq", owner, "wrun_s3", "login-s");
    await Promise.all([
      saveSiteTaskFile("teemiq", owner, "wrun_s3", saved(pdfOf("twin"))),
      saveSiteTaskFile("teemiq", owner, "wrun_s3", saved(pdfOf("twin"))),
    ]);
    await expect(countSiteTaskFiles("teemiq", owner, twins)).resolves.toBe(1);
  });

  it("saves only to this site's open task in this workspace", async () => {
    const task = await recordSiteTask("teemiq", owner, "wrun_s4", "login-s");
    const file = saved(pdfOf("scoped"));
    const closed = { ok: false, reason: "closed" };

    await expect(siteTaskFileRoom("agents", owner, "wrun_s4")).resolves.toBe(
      "closed"
    );
    await expect(siteTaskFileRoom("teemiq", other, "wrun_s4")).resolves.toBe(
      "closed"
    );
    await expect(siteTaskFileRoom("teemiq", owner, "wrun_none")).resolves.toBe(
      "closed"
    );
    await expect(
      saveSiteTaskFile("agents", owner, "wrun_s4", file)
    ).resolves.toEqual(closed);
    await expect(
      saveSiteTaskFile("teemiq", other, "wrun_s4", file)
    ).resolves.toEqual(closed);

    // Past its 45 minutes a task saves nothing more.
    await database
      .update(schema.siteTasks)
      .set({ createdAt: new Date(Date.now() - 45 * 60_000 - 1000) })
      .where(eq(schema.siteTasks.id, task));
    await expect(siteTaskFileRoom("teemiq", owner, "wrun_s4")).resolves.toBe(
      "closed"
    );
    await expect(
      saveSiteTaskFile("teemiq", owner, "wrun_s4", file)
    ).resolves.toEqual(closed);
    await expect(countSiteTaskFiles("teemiq", owner, task)).resolves.toBe(0);
  });

  it("lists and reads only this site's kept files, oldest first, the list without bytes", async () => {
    const task = await recordSiteTask("teemiq", owner, "wrun_s5", "login-s");
    const older = pdfOf("older");
    const newer = pdfOf("newer");
    const a = await saveSiteTaskFile(
      "teemiq",
      owner,
      "wrun_s5",
      saved(newer, "B.pdf")
    );
    const b = await saveSiteTaskFile(
      "teemiq",
      owner,
      "wrun_s5",
      saved(older, "A.pdf")
    );
    if (!a.ok || !b.ok) throw new Error("The files were not saved.");
    await database
      .update(schema.taskFiles)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.taskFiles.id, b.file.fileId));

    const listed = await listSiteTaskFiles("teemiq", owner, task);
    expect(listed.map(({ filename }) => filename)).toEqual(["A.pdf", "B.pdf"]);
    expect(Object.keys(listed[0] ?? {}).toSorted()).toEqual([
      "byteSize",
      "createdAt",
      "fileId",
      "filename",
      "mediaType",
      "sha256",
    ]);
    expect(listed[0]).toMatchObject({
      byteSize: older.byteLength,
      mediaType: "application/pdf",
      sha256: createHash("sha256").update(older).digest("hex"),
    });
    const read = await readSiteTaskFile("teemiq", owner, task, b.file.fileId);
    expect(Buffer.from(read?.content ?? []).equals(older)).toBe(true);
    expect(read?.byteSize).toBe(older.byteLength);

    await expect(listSiteTaskFiles("agents", owner, task)).resolves.toEqual([]);
    await expect(listSiteTaskFiles("teemiq", other, task)).resolves.toEqual([]);
    for (const [site, scope, taskId] of [
      ["agents", owner, task],
      ["teemiq", other, task],
      ["teemiq", owner, "00000000-0000-4000-8000-000000000000"],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each read is checked on its own.
      await expect(
        readSiteTaskFile(site, scope, taskId, b.file.fileId)
      ).resolves.toBeUndefined();
    }

    // Past its seven days a file is gone to every read, then purged.
    await database
      .update(schema.taskFiles)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.taskFiles.id, b.file.fileId));
    await expect(
      listSiteTaskFiles("teemiq", owner, task)
    ).resolves.toMatchObject([{ filename: "B.pdf" }]);
    await expect(
      readSiteTaskFile("teemiq", owner, task, b.file.fileId)
    ).resolves.toBeUndefined();
    await purgeExpiredTaskFiles();
    const left = await database
      .select({ id: schema.taskFiles.id })
      .from(schema.taskFiles)
      .where(eq(schema.taskFiles.taskId, task));
    expect(left).toEqual([{ id: a.file.fileId }]);
  });

  it("purges expired files a batch at a time and keeps the rest", async () => {
    const task = await recordSiteTask("teemiq", owner, "wrun_s6", "login-s");
    const content = pdfOf("expired");
    const row = {
      byteSize: content.byteLength,
      content,
      expiresAt: new Date(Date.now() - 1000),
      filename: "old.pdf",
      mediaType: "application/pdf" as const,
      sha256: "b".repeat(64),
      site: "teemiq",
      taskId: task,
      workspaceId: owner.workspaceId,
    };
    await database.insert(schema.taskFiles).values([
      ...Array.from({ length: 101 }, () => row),
      {
        ...row,
        expiresAt: new Date(Date.now() + 60_000),
        filename: "kept.pdf",
      },
    ]);
    const remaining = async () =>
      database
        .select({ filename: schema.taskFiles.filename })
        .from(schema.taskFiles)
        .where(eq(schema.taskFiles.taskId, task));

    await expect(purgeExpiredTaskFiles()).resolves.toBe(100);
    expect(await remaining()).toHaveLength(2);
    await expect(purgeExpiredTaskFiles()).resolves.toBe(1);
    expect(await remaining()).toEqual([{ filename: "kept.pdf" }]);
    await expect(purgeExpiredTaskFiles()).resolves.toBe(0);
  });
});

describe("site logins", () => {
  beforeEach(async () => {
    await ensureScope(owner);
    await ensureScope(other);
    await database.delete(schema.vaultItems);
  });

  it("keeps each site's logins apart from the owner's and other sites'", async () => {
    await saveVaultItem(owner, savedLogin("GitHub", "https://github.com"));
    const [ownLogin] = await listVaultItems(owner);
    const teemiq = await saveSiteLogin(
      owner,
      "teemiq",
      savedLogin("Vendor (Vadim)", "https://login.vendor.example")
    );
    const agents = await saveSiteLogin(
      owner,
      "agents",
      savedLogin("Vendor (Vadim)", "https://billing.other.example")
    );
    const elsewhere = await saveSiteLogin(
      other,
      "teemiq",
      savedLogin("Elsewhere", "https://login.vendor.example")
    );
    const ownLoginId = ownLogin?.id ?? "";

    await expect(listSiteLogins(owner, "teemiq")).resolves.toEqual([
      {
        alsoHosts: [],
        createdAt: teemiq.createdAt,
        hasTotp: false,
        id: teemiq.id,
        label: "Vendor (Vadim)",
        origin: "https://login.vendor.example",
      },
    ]);
    await expect(listSiteLogins(owner, "agents")).resolves.toMatchObject([
      { id: agents.id },
    ]);
    await expect(listSiteLogins(other, "teemiq")).resolves.toMatchObject([
      { id: elsewhere.id },
    ]);
    await expect(listSiteLogins(other, "agents")).resolves.toEqual([]);

    // A site pins only a login it saved, in its owner's workspace.
    await expect(readSiteLoginPin(owner, "teemiq", teemiq.id)).resolves.toEqual(
      { alsoHosts: [], id: teemiq.id, origin: "https://login.vendor.example" }
    );
    const foreign = await Promise.all([
      readSiteLoginPin(owner, "teemiq", ownLoginId),
      readSiteLoginPin(owner, "teemiq", agents.id),
      readSiteLoginPin(owner, "agents", teemiq.id),
      readSiteLoginPin(owner, "teemiq", elsewhere.id),
      readSiteLoginPin(other, "teemiq", teemiq.id),
    ]);
    expect(foreign).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);

    // The label check ignores case, and only this site's logins count.
    await expect(
      isSiteLoginLabelTaken(owner, "teemiq", "VENDOR (vadim)")
    ).resolves.toBe(true);
    await expect(
      isSiteLoginLabelTaken(owner, "teemiq", "GitHub")
    ).resolves.toBe(false);
    await expect(
      isSiteLoginLabelTaken(owner, "teemiq", "Elsewhere")
    ).resolves.toBe(false);

    // Deleting names the site too, so the owner's and other sites' logins
    // stay.
    await expect(deleteSiteLogin(owner, "teemiq", ownLoginId)).resolves.toBe(
      false
    );
    await expect(deleteSiteLogin(owner, "agents", teemiq.id)).resolves.toBe(
      false
    );
    await expect(deleteSiteLogin(other, "teemiq", teemiq.id)).resolves.toBe(
      false
    );
    await expect(deleteSiteLogin(owner, "teemiq", teemiq.id)).resolves.toBe(
      true
    );
    await expect(listSiteLogins(owner, "teemiq")).resolves.toEqual([]);
    await expect(readVaultSecret(owner, teemiq.id)).resolves.toBeUndefined();
    expect(
      (await listVaultItems(owner)).map(({ id }) => id).toSorted()
    ).toEqual([agents.id, ownLoginId].toSorted());
  });

  it("keeps the hosts a site said its login's site also uses with the login", async () => {
    const login = await saveSiteLogin(
      owner,
      "teemiq",
      savedLogin("OpenAI", "https://auth.openai.example", false, [
        "chatgpt.example",
      ])
    );

    await expect(readSiteLoginPin(owner, "teemiq", login.id)).resolves.toEqual({
      alsoHosts: ["chatgpt.example"],
      id: login.id,
      origin: "https://auth.openai.example",
    });
    await expect(listSiteLogins(owner, "teemiq")).resolves.toMatchObject([
      { alsoHosts: ["chatgpt.example"], id: login.id },
    ]);
  });

  it("lists a site's logins newest first, saying which hold an authenticator key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2026-11-01T10:00:00.000Z"));
      const first = await saveSiteLogin(
        owner,
        "teemiq",
        savedLogin("First", "https://first.example", true)
      );
      vi.setSystemTime(Date.parse("2026-11-02T10:00:00.000Z"));
      const second = await saveSiteLogin(
        owner,
        "teemiq",
        savedLogin("Second", "https://second.example")
      );

      const logins = await listSiteLogins(owner, "teemiq");

      expect(logins).toEqual([
        {
          alsoHosts: [],
          createdAt: "2026-11-02T10:00:00.000Z",
          hasTotp: false,
          id: second.id,
          label: "Second",
          origin: "https://second.example",
        },
        {
          alsoHosts: [],
          createdAt: "2026-11-01T10:00:00.000Z",
          hasTotp: true,
          id: first.id,
          label: "First",
          origin: "https://first.example",
        },
      ]);
      const listed = JSON.stringify(logins);
      for (const secret of [
        "vadim@vendor.example",
        "correct horse battery",
        "JBSWY3DPEHPK3PXP",
      ]) {
        expect(listed).not.toContain(secret);
      }
      // The account hint, which the browser worker reads, names only the
      // website, never the username, not even masked.
      await expect(listVaultItems(owner)).resolves.toMatchObject([
        { account: "second.example", site: "teemiq" },
        { account: "first.example", site: "teemiq" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function savedLogin(
  label: string,
  origin: string,
  withKey = false,
  alsoHosts?: string[]
) {
  return {
    account: "",
    kind: "login" as const,
    label,
    secret: serializeLoginVaultPayload({
      alsoHosts,
      authentication: {
        password: "correct horse battery",
        totp: withKey
          ? {
              algorithm: "SHA1",
              digits: 6,
              period: 30,
              secret: "JBSWY3DPEHPK3PXP",
            }
          : undefined,
        type: "password",
      },
      identifier: { type: "email", value: "vadim@vendor.example" },
      kind: "login",
      origin,
      version: 2,
    }),
  };
}
