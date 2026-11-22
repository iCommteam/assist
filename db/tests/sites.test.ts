import { PGlite } from "@electric-sql/pglite";
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
  isSiteTaskSession,
  recordSiteTask,
  resolveSiteOwner,
} from "@db/services/sites";
import { accessScopeForUser } from "@shared/identity/access-scope";

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
    const taskId = await recordSiteTask("teemiq", owner, "wrun_teemiq");

    expect(taskId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(findSiteTaskSession("teemiq", owner, taskId)).resolves.toBe(
      "wrun_teemiq"
    );
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
  });

  it("records one site per session", async () => {
    await ensureScope(owner);
    await recordSiteTask("teemiq", owner, "wrun_once");

    await expect(recordSiteTask("agents", owner, "wrun_once")).rejects.toThrow(
      "Failed query"
    );
  });
});
