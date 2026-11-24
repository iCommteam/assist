import type * as EveConnections from "eve/connections";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readSiteChatToken } from "@db/services/site-chats";
import {
  dynamicContextFor,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  financeMcpUrl: vi.fn<() => string | undefined>(),
  readSiteChatToken: vi.fn<typeof readSiteChatToken>(),
}));

vi.mock("eve/connections", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveConnections>())
);
vi.mock("@db/services/site-chats", () => ({
  readSiteChatToken: mocks.readSiteChatToken,
}));
vi.mock("@shared/environment", () => ({
  env: {
    get TEEMIQ_FINANCE_MCP_URL() {
      return mocks.financeMcpUrl();
    },
  },
}));

const { default: teemiq } = await import("@agent/connections/teemiq");
const { isConnectionAuthorizationFailedError } =
  await import("eve/connections");

const owner = accessScopeForUser("better-auth:owner-1");
const chatA = "00000000-0000-4000-8000-00000000000a";
const chatB = "00000000-0000-4000-8000-00000000000b";
const url = "https://team.example/api/mcp/finance";
// The fake chats' tokens, as their rows would hold them.
const tokens = new Map([
  [`${chatA}/wrun_a`, "token-of-chat-a-0123456789"],
  [`${chatB}/wrun_b`, "token-of-chat-b-0123456789"],
]);

function chatContext(chatId: string, sessionId: string) {
  const chat = sitePrincipal(
    { chat: chatId, op: "chat.create", site: "teemiq", siteUser: "user-1" },
    "owner@example.test",
    owner
  );
  return dynamicContextFor({
    auth: { current: chat, initiator: chat },
    sessionId,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.financeMcpUrl.mockReturnValue(url);
  mocks.readSiteChatToken.mockImplementation(
    async (_scope, chatId, sessionId) => {
      const token = tokens.get(`${chatId}/${sessionId}`);
      return token ? { expiresAt: Date.now() + 60_000, token } : undefined;
    }
  );
});

describe("teemiq connection", () => {
  it("connects a site chat to the finance route with that chat's own token", async () => {
    const [connectionA, connectionB] = await Promise.all([
      evaluateDynamic(teemiq, chatContext(chatA, "wrun_a")),
      evaluateDynamic(teemiq, chatContext(chatB, "wrun_b")),
    ]);
    if (!connectionA || !connectionB || !("auth" in connectionA)) {
      throw new Error("Expected both chats to have the connection.");
    }

    expect(connectionA).toMatchObject({
      instanceKey: chatA,
      tools: {
        allow: [
          "finance_find_transactions",
          "finance_get_transaction",
          "finance_missing_invoices",
          "finance_find_documents",
          "finance_get_document",
          "finance_suppliers",
          "finance_site_accounts",
          "finance_site_look",
          "finance_fetch_invoice",
          "finance_fetch_status",
          "finance_propose_pairing",
          "finance_propose_invoice_way",
        ],
      },
      url,
    });
    expect(connectionB).toMatchObject({ instanceKey: chatB });
    const principal = { id: owner.userId, type: "user" } as const;
    const tokenOf = async (connection: typeof connectionA) => {
      const { auth } = connection;
      if (!auth || !("getToken" in auth)) {
        throw new Error("Expected a token provider.");
      }
      return auth.getToken({ connection: { url }, principal });
    };
    await expect(tokenOf(connectionA)).resolves.toMatchObject({
      token: "token-of-chat-a-0123456789",
    });
    await expect(tokenOf(connectionB)).resolves.toMatchObject({
      token: "token-of-chat-b-0123456789",
    });
    expect(mocks.readSiteChatToken).toHaveBeenCalledWith(
      owner,
      chatA,
      "wrun_a"
    );
  });

  it("offers no finance tools in a turn whose chat holds no live token", async () => {
    mocks.readSiteChatToken.mockResolvedValue(undefined);

    await expect(
      evaluateDynamic(teemiq, chatContext(chatA, "wrun_a"))
    ).resolves.toBeNull();
  });

  it("fails a call whose token ran out after the turn began, without asking anyone to sign in", async () => {
    const connection = await evaluateDynamic(
      teemiq,
      chatContext(chatA, "wrun_a")
    );
    if (!connection || !("auth" in connection)) {
      throw new Error("Expected the connection.");
    }
    const { auth } = connection;
    if (!auth || !("getToken" in auth)) {
      throw new Error("Expected a token provider.");
    }
    mocks.readSiteChatToken.mockResolvedValue(undefined);

    await expect(
      auth.getToken({
        connection: { url },
        principal: { id: owner.userId, type: "user" },
      })
    ).rejects.toSatisfy(isConnectionAuthorizationFailedError);
  });

  it("is absent without its URL, and outside a site chat", async () => {
    const task = sitePrincipal(
      { op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );
    const member = {
      attributes: { workspaceId: owner.workspaceId },
      authenticator: "authjs",
      principalId: owner.userId,
      principalType: "user",
    };

    const outside = await Promise.all(
      [task, member].map((principal) =>
        evaluateDynamic(
          teemiq,
          dynamicContextFor({
            auth: { current: principal, initiator: principal },
            sessionId: "wrun_a",
          })
        )
      )
    );
    mocks.financeMcpUrl.mockReturnValue(undefined);
    const unset = await evaluateDynamic(teemiq, chatContext(chatA, "wrun_a"));

    expect([...outside, unset]).toEqual([null, null, null]);
    expect(mocks.readSiteChatToken).not.toHaveBeenCalled();
  });
});
