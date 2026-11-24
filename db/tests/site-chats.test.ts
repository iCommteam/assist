import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import { saveChat } from "@db/services/chats";
import { ensureScope } from "@db/services/scope";
import { claimSession } from "@db/services/sessions";
import {
  clearSiteChatToken,
  findSiteChat,
  isAnySiteChatSession,
  isSiteChatSession,
  listSiteChats,
  readSiteChatToken,
  recordSiteChat,
  storeSiteChatToken,
} from "@db/services/site-chats";
import { accessScopeForUser } from "@shared/identity/access-scope";

const client = new PGlite();
const database = drizzle(client, { schema });
const owner = accessScopeForUser("better-auth:owner-id");
const other = accessScopeForUser("better-auth:other-id");
const chatA = "00000000-0000-4000-8000-00000000000a";
const chatB = "00000000-0000-4000-8000-00000000000b";
const chatC = "00000000-0000-4000-8000-00000000000c";
const token = "teemiq-chat-token-0123456789abcdef";

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
  await ensureScope(owner);
  await ensureScope(other);
  await recordSiteChat("teemiq", owner, {
    id: chatA,
    sessionId: "wrun_a",
    siteUser: "user-1",
    title: "OpenAI · 3 Nov",
    topic: "txn:1",
  });
  await recordSiteChat("teemiq", owner, {
    id: chatB,
    sessionId: "wrun_b",
    siteUser: "user-1",
    title: undefined,
    topic: undefined,
  });
  await recordSiteChat("teemiq", owner, {
    id: chatC,
    sessionId: "wrun_c",
    siteUser: "user-2",
    title: "Other person",
    topic: "txn:1",
  });
}, 20_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("site chats", () => {
  it("finds a chat only for its own site, workspace and person", async () => {
    await expect(
      findSiteChat("teemiq", owner, "user-1", chatA)
    ).resolves.toMatchObject({ sessionId: "wrun_a" });
    for (const [site, scope, siteUser] of [
      ["agents", owner, "user-1"],
      ["teemiq", other, "user-1"],
      ["teemiq", owner, "user-2"],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each refused lookup is its own query.
      await expect(
        findSiteChat(site, scope, siteUser, chatA)
      ).resolves.toBeUndefined();
    }
    await expect(
      isSiteChatSession("teemiq", owner, "user-1", chatA, "wrun_a")
    ).resolves.toBe(true);
    await expect(
      isSiteChatSession("teemiq", owner, "user-1", chatA, "wrun_b")
    ).resolves.toBe(false);
    await expect(
      isSiteChatSession("teemiq", owner, "user-2", chatA, "wrun_a")
    ).resolves.toBe(false);
  });

  it("lists a person's chats newest first, by topic when asked, and no one else's", async () => {
    const all = await listSiteChats("teemiq", owner, "user-1", undefined, 50);
    expect(all.map(({ chatId }) => chatId)).toEqual([chatB, chatA]);
    const { createdAt, ...first } = all[1] ?? {};
    expect(first).toEqual({
      chatId: chatA,
      title: "OpenAI · 3 Nov",
      topic: "txn:1",
    });
    expect(createdAt).toBeInstanceOf(Date);
    await expect(
      listSiteChats("teemiq", owner, "user-1", "txn:1", 50)
    ).resolves.toMatchObject([{ chatId: chatA }]);
    await expect(
      listSiteChats("teemiq", owner, "user-2", "txn:1", 50)
    ).resolves.toMatchObject([{ chatId: chatC }]);
    await expect(
      listSiteChats("teemiq", other, "user-1", undefined, 50)
    ).resolves.toEqual([]);
  });

  it("knows every site chat's session, in any workspace", async () => {
    await expect(isAnySiteChatSession("wrun_c")).resolves.toBe(true);
    await expect(isAnySiteChatSession("wrun_task")).resolves.toBe(false);
  });

  it("keeps a chat's token encrypted, for that chat's session alone, until the turn clears it", async () => {
    await expect(
      storeSiteChatToken("teemiq", owner, "user-2", chatA, token)
    ).resolves.toBe(false);
    await expect(
      storeSiteChatToken("teemiq", owner, "user-1", chatA, token)
    ).resolves.toBe(true);

    const [row] = await database
      .select({
        expiresAt: schema.siteChats.teemiqTokenExpiresAt,
        sealed: schema.siteChats.teemiqToken,
      })
      .from(schema.siteChats)
      .where(eq(schema.siteChats.id, chatA));
    expect(row?.sealed).toMatch(/^v1\./u);
    expect(row?.sealed).not.toContain(token);
    expect((row?.expiresAt?.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(
      15 * 60_000
    );

    await expect(readSiteChatToken(owner, chatA, "wrun_a")).resolves.toEqual({
      expiresAt: row?.expiresAt?.getTime(),
      token,
    });
    await expect(
      readSiteChatToken(owner, chatA, "wrun_b")
    ).resolves.toBeUndefined();
    await expect(
      readSiteChatToken(other, chatA, "wrun_a")
    ).resolves.toBeUndefined();
    await expect(
      readSiteChatToken(owner, chatB, "wrun_b")
    ).resolves.toBeUndefined();

    // A sealed token moved to another chat's row does not open there.
    await database
      .update(schema.siteChats)
      .set({ teemiqToken: row?.sealed, teemiqTokenExpiresAt: row?.expiresAt })
      .where(eq(schema.siteChats.id, chatB));
    await expect(
      readSiteChatToken(owner, chatB, "wrun_b")
    ).resolves.toBeUndefined();

    await clearSiteChatToken("wrun_a");
    await expect(
      readSiteChatToken(owner, chatA, "wrun_a")
    ).resolves.toBeUndefined();
    const [cleared] = await database
      .select({
        expiresAt: schema.siteChats.teemiqTokenExpiresAt,
        sealed: schema.siteChats.teemiqToken,
      })
      .from(schema.siteChats)
      .where(eq(schema.siteChats.id, chatA));
    expect(cleared).toEqual({ expiresAt: null, sealed: null });
  });

  it("clears at a turn's end only a token that arrived by the turn's last message", async () => {
    const before = Date.now();
    await storeSiteChatToken("teemiq", owner, "user-1", chatB, token);

    // The turn took its last message before this token arrived.
    await clearSiteChatToken("wrun_b", new Date(before - 1));
    await expect(
      readSiteChatToken(owner, chatB, "wrun_b")
    ).resolves.toMatchObject({ token });

    await clearSiteChatToken("wrun_b", new Date());
    await expect(
      readSiteChatToken(owner, chatB, "wrun_b")
    ).resolves.toBeUndefined();
  });

  it("reads a token that has run out as none", async () => {
    await storeSiteChatToken("teemiq", owner, "user-2", chatC, token);
    await database
      .update(schema.siteChats)
      .set({ teemiqTokenExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.siteChats.id, chatC));

    await expect(
      readSiteChatToken(owner, chatC, "wrun_c")
    ).resolves.toBeUndefined();
  });

  it("never adds a site chat to the owner's chat list", async () => {
    await claimSession(owner, "wrun_a");
    await claimSession(owner, "wrun_member");

    await saveChat(owner, { sessionId: "wrun_a", title: "Probe" });
    await saveChat(owner, { sessionId: "wrun_member", title: "Mine" });

    const titles = await database
      .select({ sessionId: schema.chats.sessionId })
      .from(schema.chats);
    expect(titles).toEqual([{ sessionId: "wrun_member" }]);
  });
});
