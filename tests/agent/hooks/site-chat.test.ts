import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractionOpened } from "eve/events";
import type { HookContext } from "eve/hooks";
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
