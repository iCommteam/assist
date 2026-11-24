import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Fact, TurnSettled } from "eve/events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import siteChat from "@agent/hooks/site-chat";
import { sitePrincipal } from "@agent/lib/site-principal";
import { ensureScope } from "@db/services/scope";
import {
  readSiteChatToken,
  recordSiteChat,
  storeSiteChatToken,
} from "@db/services/site-chats";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { hookContextFor } from "@tests/helpers/hook-context";
import { viewAt } from "@tests/helpers/session-view";

// The production hook and token store together, on the race between a turn
// ending and the site sending the next message with a fresh token.
const client = new PGlite();
const database = drizzle(client, { schema });
const owner = accessScopeForUser("better-auth:owner-1");
const chatId = "00000000-0000-4000-8000-0000000000c1";
const token = "teemiq-chat-token-0123456789abcdef";
const chat = sitePrincipal(
  { chat: chatId, op: "chat.create", site: "teemiq", siteUser: "user-1" },
  "owner@example.test",
  owner
);
const settled = {
  data: { outcome: "completed", turnId: "t" },
  scope: { turnId: "t" },
  type: "turn.settled",
} satisfies TurnSettled;

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema, services and hook with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
  await ensureScope(owner);
  await recordSiteChat("teemiq", owner, {
    id: chatId,
    sessionId: "wrun_chat",
    siteUser: "user-1",
    title: undefined,
    topic: undefined,
  });
}, 20_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("site chat token at the end of a turn", () => {
  it("keeps a token the site stored after the turn took its last message, for the next turn", async () => {
    // The turn took the person's message a minute ago and worked since. As
    // it settles, the site posts a fetch's result with a fresh token.
    const tookAt = new Date(Date.now() - 60_000);
    await storeSiteChatToken("teemiq", owner, "user-1", chatId, token);

    await settleTurn(tookAt, new Date());

    await expect(
      readSiteChatToken(owner, chatId, "wrun_chat")
    ).resolves.toMatchObject({ token });
  });

  it("clears the token of the message the turn took", async () => {
    // The site stores the token, then sends the message the turn takes.
    await storeSiteChatToken("teemiq", owner, "user-1", chatId, token);
    const tookAt = new Date(Date.now() + 1000);

    await settleTurn(tookAt, new Date(tookAt.getTime() + 1000));

    await expect(
      readSiteChatToken(owner, chatId, "wrun_chat")
    ).resolves.toBeUndefined();
  });

  it("clears any token when the session ends", async () => {
    await storeSiteChatToken("teemiq", owner, "user-1", chatId, token);

    await siteChat.events["session.ended"]?.(
      { data: { outcome: "completed" }, type: "session.ended" },
      context(new Date())
    );

    await expect(
      readSiteChatToken(owner, chatId, "wrun_chat")
    ).resolves.toBeUndefined();
  });
});

async function settleTurn(tookAt: Date, settledAt: Date) {
  await siteChat.events["turn.settled"]?.(
    settled,
    context(settledAt, [
      [
        tookAt.toISOString(),
        [
          { data: { deliveryId: "d1" }, type: "delivery.admitted" },
          {
            data: { cause: { deliveryId: "d1" }, follows: null, turnId: "t" },
            type: "turn.started",
          },
          {
            data: {
              deliveryId: "d1",
              parts: [{ kind: "text", text: "Get this invoice" }],
              turnId: "t",
            },
            scope: { turnId: "t" },
            type: "delivery.consumed",
          },
        ],
      ],
      [
        settledAt.toISOString(),
        [
          settled,
          {
            data: { deliveryId: "d1", outcome: "handled", turnId: "t" },
            type: "delivery.settled",
          },
        ],
      ],
    ])
  );
}

function context(
  now: Date,
  lines: readonly (readonly [string, readonly Fact[]])[] = []
) {
  return hookContextFor({
    auth: { current: chat, initiator: chat },
    now,
    sessionId: "wrun_chat",
    view: viewAt(lines),
  });
}
