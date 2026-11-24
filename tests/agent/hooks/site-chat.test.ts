import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractionOpened, TurnSettled } from "eve/events";
import type { HookContext } from "eve/hooks";
import type { clearSiteChatToken } from "@db/services/site-chats";

const mocks = vi.hoisted(() => ({
  clearSiteChatToken: vi.fn<typeof clearSiteChatToken>(),
}));
vi.mock("@db/services/site-chats", () => ({
  clearSiteChatToken: mocks.clearSiteChatToken,
}));

import siteChat from "@agent/hooks/site-chat";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { hookContextFor } from "@tests/helpers/hook-context";

const owner = accessScopeForUser("better-auth:owner-1");
const chat = sitePrincipal(
  {
    chat: "00000000-0000-4000-8000-0000000000c1",
    op: "chat.create",
    site: "teemiq",
    siteUser: "teemiq-user-1",
  },
  "owner@example.test",
  owner
);
const task = sitePrincipal(
  { op: "create", site: "teemiq" },
  "owner@example.test",
  owner
);

const budget = opened({
  kind: "budget",
  options: [
    { id: "continue", label: "Continue" },
    { id: "stop", label: "Stop" },
  ],
  prompt: "This session reached its usage limit. Continue?",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("site chat input hook", () => {
  it("lets a chat ask its person a question", async () => {
    const cancel = await fire(
      opened({
        kind: "question",
        options: [
          { id: "business", label: "OpenAI business" },
          { id: "personal", label: "OpenAI personal" },
        ],
        prompt: "Which account?",
      }),
      chat
    );

    expect(cancel).not.toHaveBeenCalled();
  });

  it("answers the usage limit's prompt no, by stopping the turn", async () => {
    const cancel = await fire(budget, chat);

    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      "The chat reached its usage limit."
    );
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "[site] chat stopped at a request its site cannot answer",
      { kind: "budget", site: "teemiq" }
    );
  });

  it.each([
    ["a tool approval", opened({ kind: "approval", prompt: "Approve?" })],
    [
      "a sign-in",
      opened({
        kind: "sign-in",
        prompt: "Sign in to teemiq",
        signIn: { name: "teemiq" },
      }),
    ],
  ])("stops a chat at %s", async (_case, event) => {
    const cancel = await fire(event, chat);

    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      "The chat needs an answer that its site cannot give."
    );
  });

  it("leaves site tasks and members' sessions alone", async () => {
    const member = {
      attributes: { workspaceId: owner.workspaceId },
      authenticator: "authjs",
      principalId: owner.userId,
      principalType: "user",
    };

    expect(await fire(budget, task)).not.toHaveBeenCalled();
    expect(await fire(budget, member)).not.toHaveBeenCalled();
  });
});

describe("site chat token", () => {
  const settled = {
    data: { outcome: "completed", turnId: "t" },
    scope: { turnId: "t" },
    type: "turn.settled",
  } satisfies TurnSettled;

  it("forgets the site's token at the end of every turn and of the session", async () => {
    const context = hookContextFor({
      auth: { current: chat, initiator: chat },
      sessionId: "wrun_chat",
    });

    await siteChat.events["turn.settled"]?.(settled, context);
    await siteChat.events["session.ended"]?.(
      { data: { outcome: "completed" }, type: "session.ended" },
      context
    );

    expect(mocks.clearSiteChatToken.mock.calls).toEqual([
      ["wrun_chat"],
      ["wrun_chat"],
    ]);
  });

  it("keeps the turn when the token cannot be cleared, which runs out by itself", async () => {
    mocks.clearSiteChatToken.mockRejectedValueOnce(new Error("db down"));

    await expect(
      siteChat.events["turn.settled"]?.(
        settled,
        hookContextFor({ auth: { current: chat, initiator: chat } })
      )
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "[site] chat token could not be cleared",
      { error: "Error", site: "teemiq" }
    );
  });

  it("touches no row for a site task", async () => {
    await siteChat.events["turn.settled"]?.(
      settled,
      hookContextFor({ auth: { current: task, initiator: task } })
    );

    expect(mocks.clearSiteChatToken).not.toHaveBeenCalled();
  });
});

function opened(request: InteractionOpened["data"]["request"]) {
  return {
    data: { interactionId: "interaction-1", request, subject: { turnId: "t" } },
    scope: { turnId: "t" },
    type: "interaction.opened",
  } satisfies InteractionOpened;
}

async function fire(
  event: InteractionOpened,
  initiator: NonNullable<HookContext["session"]["auth"]["initiator"]>
) {
  const cancel = vi.fn<HookContext["cancel"]>();
  const handler = siteChat.events["interaction.opened"];
  expect(handler).toBeDefined();
  await handler?.(event, {
    ...hookContextFor({ auth: { current: initiator, initiator } }),
    cancel,
  });
  return cancel;
}
