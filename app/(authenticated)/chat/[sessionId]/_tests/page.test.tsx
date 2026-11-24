import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readChat } from "@db/services/chats";
import type { isAnySiteChatSession } from "@db/services/site-chats";
import type { requireRequestScope } from "@web/auth/request-scope";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  isAnySiteChatSession: vi.fn<typeof isAnySiteChatSession>(),
  readChat: vi.fn<typeof readChat>(),
  requireRequestScope: vi.fn<typeof requireRequestScope>(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
}));
vi.mock("@db/services/chats", () => ({ readChat: mocks.readChat }));
vi.mock("@db/services/site-chats", () => ({
  isAnySiteChatSession: mocks.isAnySiteChatSession,
}));
vi.mock("@web/auth/request-scope", () => ({
  requireRequestScope: mocks.requireRequestScope,
}));
vi.mock(
  "@app/(authenticated)/chat/[sessionId]/_components/chat-session",
  () => ({
    ChatSession: () => null,
  })
);

const { default: ChatSessionPage } = await import("../page");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRequestScope.mockResolvedValue(
    accessScopeForUser("better-auth:owner-1")
  );
  mocks.readChat.mockResolvedValue(undefined);
  mocks.isAnySiteChatSession.mockResolvedValue(false);
});

function render(sessionId: string) {
  return ChatSessionPage({
    params: Promise.resolve({ sessionId }),
    searchParams: Promise.resolve({}),
  });
}

describe("chat session page", () => {
  it("is not found for a site chat, even to the owner whose workspace holds it", async () => {
    mocks.isAnySiteChatSession.mockResolvedValue(true);

    await expect(render("wrun_chat")).rejects.toThrow("Not found");
    expect(mocks.isAnySiteChatSession).toHaveBeenCalledExactlyOnceWith(
      "wrun_chat"
    );
    expect(mocks.readChat).not.toHaveBeenCalled();
  });

  it("opens the owner's own chat", async () => {
    await expect(render("wrun_mine")).resolves.toBeDefined();
    expect(mocks.readChat).toHaveBeenCalledOnce();
  });
});
