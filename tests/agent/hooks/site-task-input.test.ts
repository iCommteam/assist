import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractionOpened } from "eve/events";
import type { HookContext } from "eve/hooks";
import siteTaskInput from "@agent/hooks/site-task-input";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { hookContextFor } from "@tests/helpers/hook-context";

const owner = accessScopeForUser("better-auth:owner-1");
const site = sitePrincipal(
  {
    login: { id: "login-1", origin: "https://login.vendor.example" },
    op: "create",
    site: "teemiq",
  },
  "owner@example.test",
  owner
);
const member = {
  attributes: { workspaceId: owner.workspaceId },
  authenticator: "authjs",
  principalId: owner.userId,
  principalType: "user",
};

const budget = opened({
  kind: "budget",
  options: [
    { id: "continue", label: "Continue" },
    { id: "stop", label: "Stop" },
  ],
  prompt: "This session reached its usage limit. Continue?",
});
const codeQuestion = opened({
  allowFreeform: true,
  display: "text",
  kind: "question",
  prompt: "Enter the one-time code that login.vendor.example just sent.",
  title: "One-time code",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("site task input hook", () => {
  it("stops a site task at the usage limit instead of waiting for an answer", async () => {
    const cancel = await fire(budget, { current: site, initiator: site });

    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      "The site task reached its usage limit."
    );
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "[site] task stopped at a request a site cannot answer",
      { kind: "budget", site: "teemiq" }
    );
  });

  it.each([
    [
      "a model's question",
      opened({ kind: "question", prompt: "Which invoice did you mean?" }),
    ],
    [
      "a question that copies the code question's words but not its title",
      opened({
        kind: "question",
        prompt: "Enter the one-time code that login.vendor.example just sent.",
      }),
    ],
    [
      "a tool approval",
      opened({ kind: "approval", prompt: "Approve schedules-create?" }),
    ],
  ])("stops a site task at %s", async (_case, event) => {
    const cancel = await fire(event, { current: site, initiator: site });

    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      "The site task needs an answer that a site cannot give."
    );
  });

  it("lets a site task wait for the browser worker's code question", async () => {
    const cancel = await fire(codeQuestion, { current: site, initiator: site });

    expect(cancel).not.toHaveBeenCalled();
  });

  it("also stops a turn the owner writes into a site task's chat", async () => {
    const cancel = await fire(budget, { current: member, initiator: site });

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("leaves interactive and scheduled sessions waiting for their person", async () => {
    const scheduled = {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    };

    expect(
      await fire(budget, { current: member, initiator: member })
    ).not.toHaveBeenCalled();
    expect(
      await fire(budget, { current: scheduled, initiator: scheduled })
    ).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
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
  auth: HookContext["session"]["auth"]
) {
  const cancel = vi.fn<HookContext["cancel"]>();
  const handler = siteTaskInput.events["interaction.opened"];
  expect(handler).toBeDefined();
  await handler?.(event, { ...hookContextFor({ auth }), cancel });
  return cancel;
}
