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
  findSiteTaskSession,
  isAnySiteTaskSession,
  isSiteTaskSession,
  listSiteTasksOfLogin,
  recordSiteTask,
  resolveSiteOwner,
} from "@db/services/sites";
import {
  deleteSiteLogin,
  isSiteLoginLabelTaken,
  listSiteLogins,
  listVaultItems,
  readSiteLoginOrigin,
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
  it("lists one site's tasks pinned to a login since a time, newest first", async () => {
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
    await pinned("teemiq", owner, "wrun_l3", "login-a", 50);
    await pinned("teemiq", owner, "wrun_l4", "login-b", 5);
    await pinned("teemiq", owner, "wrun_l5", undefined, 5);
    await pinned("agents", owner, "wrun_l6", "login-a", 5);
    await pinned("teemiq", other, "wrun_l7", "login-a", 5);

    const tasks = await listSiteTasksOfLogin(
      "teemiq",
      owner,
      "login-a",
      new Date(now - 45 * 60_000)
    );

    expect(tasks.map(({ id }) => id)).toEqual([newer, older]);
    expect(tasks.map(({ sessionId }) => sessionId)).toEqual([
      "wrun_l2",
      "wrun_l1",
    ]);
    expect(tasks[0]?.createdAt).toBeInstanceOf(Date);
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
    await expect(readSiteLoginOrigin(owner, "teemiq", teemiq.id)).resolves.toBe(
      "https://login.vendor.example"
    );
    const foreign = await Promise.all([
      readSiteLoginOrigin(owner, "teemiq", ownLoginId),
      readSiteLoginOrigin(owner, "teemiq", agents.id),
      readSiteLoginOrigin(owner, "agents", teemiq.id),
      readSiteLoginOrigin(owner, "teemiq", elsewhere.id),
      readSiteLoginOrigin(other, "teemiq", teemiq.id),
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
          createdAt: "2026-11-02T10:00:00.000Z",
          hasTotp: false,
          id: second.id,
          label: "Second",
          origin: "https://second.example",
        },
        {
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

function savedLogin(label: string, origin: string, withKey = false) {
  return {
    account: "",
    kind: "login" as const,
    label,
    secret: serializeLoginVaultPayload({
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
