import type { InteractionOpened, TaskStarted, TurnStarted } from "eve/events";
import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { enrolledTeamMemberId } from "@db/services/auth/allowlist";
import type {
  claimWhatsappBrowserTask,
  whatsappChatOfSession,
  whatsappLockOf,
} from "@db/services/whatsapp";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { hookContextFor } from "@tests/helpers/hook-context";
import { viewOf } from "@tests/helpers/session-view";

const mocks = vi.hoisted(() => ({
  claimWhatsappBrowserTask: vi.fn<typeof claimWhatsappBrowserTask>(),
  enrolledTeamMemberId: vi.fn<typeof enrolledTeamMemberId>(),
  numbers: "",
  whatsappChatOfSession: vi.fn<typeof whatsappChatOfSession>(),
  whatsappLockOf: vi.fn<typeof whatsappLockOf>(),
}));

vi.mock("@db/services/auth/allowlist", () => ({
  enrolledTeamMemberId: mocks.enrolledTeamMemberId,
}));
vi.mock("@db/services/whatsapp", () => ({
  claimWhatsappBrowserTask: mocks.claimWhatsappBrowserTask,
  whatsappChatOfSession: mocks.whatsappChatOfSession,
  whatsappLockOf: mocks.whatsappLockOf,
}));
vi.mock("@shared/environment", () => ({
  env: {},
  whatsappNumbersVariable: () => mocks.numbers,
}));

import rootHook from "@agent/hooks/whatsapp-access";
import { takeWhatsappCancelNotice } from "@agent/lib/whatsapp-access";
import workerHook from "@agent/subagents/browser-agent/hooks/whatsapp-access";

const memberNumber = "+15550000001";
const workspaceId = accessScopeForUser("better-auth:user-1").workspaceId;
const full = {
  attributes: {
    conversationChannel: "whatsapp",
    email: "member@example.test",
    whatsappAccess: "full",
    whatsappNumber: memberNumber,
    workspaceId,
  },
  authenticator: "assist-whatsapp",
  principalId: "better-auth:user-1",
  principalType: "user",
};
const narrow = {
  attributes: {
    conversationChannel: "whatsapp",
    email: "member@example.test",
    workspaceId,
  },
  authenticator: "assist-whatsapp",
  principalId: "better-auth:user-1",
  principalType: "user",
};
const web = {
  attributes: { conversationChannel: "eve", workspaceId },
  authenticator: "authjs",
  principalId: "better-auth:user-1",
  principalType: "user",
};

const turnStarted = {
  data: {
    cause: { deliveryId: "delivery-1" },
    follows: null,
    turnId: "turn-1",
  },
  scope: { turnId: "turn-1" },
  type: "turn.started",
} satisfies TurnStarted;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.numbers = `${memberNumber}=member@example.test`;
  mocks.enrolledTeamMemberId.mockResolvedValue("user-1");
  mocks.whatsappLockOf.mockResolvedValue({ everyone: false, self: false });
  mocks.claimWhatsappBrowserTask.mockResolvedValue(true);
  mocks.whatsappChatOfSession.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function context(
  initiator: typeof full | typeof narrow | typeof web | null,
  options: { parentRoot?: string; view?: HookContext["view"] } = {}
) {
  const cancel = vi.fn<HookContext["cancel"]>();
  return {
    cancel,
    ctx: {
      ...hookContextFor({
        auth: { current: initiator, initiator },
        parent:
          options.parentRoot === undefined
            ? undefined
            : {
                callId: "call-1",
                rootSessionId: options.parentRoot,
                sessionId: options.parentRoot,
                turn: { id: "root-turn", sequence: 0 },
              },
        sessionId: "session-1",
        view: options.view,
      }),
      cancel,
    },
  };
}

async function fireRootTurn(initiator: Parameters<typeof context>[0]) {
  const { cancel, ctx } = context(initiator);
  await rootHook.events["turn.started"]?.(turnStarted, ctx);
  return cancel;
}

describe("the root agent's WhatsApp kill switch", () => {
  it("lets a full chat go on while its member may still use it", async () => {
    expect(await fireRootTurn(full)).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the member locked it",
      () => {
        mocks.whatsappLockOf.mockResolvedValue({ everyone: false, self: true });
      },
    ],
    [
      "an administrator locked everyone",
      () => {
        mocks.whatsappLockOf.mockResolvedValue({ everyone: true, self: false });
      },
    ],
    [
      "the number is listed for someone else",
      () => {
        mocks.numbers = `${memberNumber}=other@example.test`;
      },
    ],
    [
      "the member can no longer sign in",
      () => {
        mocks.enrolledTeamMemberId.mockResolvedValue(undefined);
      },
    ],
    [
      "the access cannot be read",
      () => {
        mocks.whatsappLockOf.mockRejectedValue(new Error("database down"));
      },
    ],
  ])("cancels a full chat's turn once %s", async (_case, arrange) => {
    arrange();
    expect(await fireRootTurn(full)).toHaveBeenCalledOnce();
  });

  it("cancels a full chat's model calls and tool calls too, whoever sent the turn", async () => {
    mocks.whatsappLockOf.mockResolvedValue({ everyone: false, self: true });
    const { cancel, ctx } = context(full);
    const webTurn = {
      ...ctx,
      session: { ...ctx.session, auth: { current: web, initiator: full } },
    };

    await rootHook.events["model.requested"]?.(
      {
        data: { owner: { turnId: "turn-1" }, runId: "run-1" },
        scope: { runId: "run-1", turnId: "turn-1" },
        type: "model.requested",
      },
      webTurn
    );
    await rootHook.events["call.requested"]?.(
      {
        data: {
          callId: "call-1",
          capability: { kind: "tool", name: "run_browser" },
          input: {},
          owner: { runId: "run-1" },
        },
        scope: { runId: "run-1", turnId: "turn-1" },
        type: "call.requested",
      },
      webTurn
    );

    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("lets a narrow chat go on when it is locked, and stops it only when its member's number is gone", async () => {
    mocks.whatsappLockOf.mockResolvedValue({ everyone: true, self: true });
    expect(await fireRootTurn(narrow)).not.toHaveBeenCalled();

    mocks.whatsappLockOf.mockRejectedValue(new Error("database down"));
    expect(await fireRootTurn(narrow)).not.toHaveBeenCalled();

    mocks.numbers = "";
    expect(await fireRootTurn(narrow)).toHaveBeenCalledOnce();
  });

  it("leaves every other session alone", async () => {
    mocks.numbers = "";
    expect(await fireRootTurn(web)).not.toHaveBeenCalled();
    expect(await fireRootTurn(null)).not.toHaveBeenCalled();
    expect(mocks.whatsappLockOf).not.toHaveBeenCalled();
  });
});

describe("what a WhatsApp chat can be asked", () => {
  const budget = (id: string) =>
    opened(id, {
      kind: "budget",
      options: [
        { id: "continue", label: "Continue" },
        { id: "stop", label: "Stop" },
      ],
      prompt: "This chat reached its usage limit. Continue?",
    });

  async function fire(
    event: InteractionOpened,
    initiator: Parameters<typeof context>[0],
    earlier: readonly InteractionOpened[] = []
  ) {
    const { cancel, ctx } = context(initiator, {
      view: viewOf([[...earlier, event]]),
    });
    await rootHook.events["interaction.opened"]?.(event, ctx);
    return cancel;
  }

  it("lets a question through", async () => {
    const question = opened("q-1", {
      kind: "question",
      options: [{ id: "march", label: "March" }],
      prompt: "Which month?",
    });
    expect(await fire(question, full)).not.toHaveBeenCalled();
    expect(await fire(question, narrow)).not.toHaveBeenCalled();
  });

  it("continues past the usage limit once per chat, and stops at the second, saying so", async () => {
    expect(await fire(budget("b-1"), full)).not.toHaveBeenCalled();
    const second = await fire(budget("b-2"), full, [budget("b-1")]);
    expect(second).toHaveBeenCalledOnce();
    expect(takeWhatsappCancelNotice("session-1", "turn-1")).toBe(
      "This chat has reached its usage limit again. Reply /new to start a new chat."
    );
  });

  it.each([
    ["an approval", { kind: "approval", prompt: "Create this schedule?" }],
    ["a sign-in", { kind: "sign-in", prompt: "Connect your account." }],
  ] as const)(
    "stops at %s, which WhatsApp cannot show",
    async (_case, request) => {
      expect(await fire(opened("i-1", request), full)).toHaveBeenCalledOnce();
      expect(takeWhatsappCancelNotice("session-1", "turn-1")).toBe(
        "That step can't be done on WhatsApp. Continue in assist's web app."
      );
    }
  );

  it("leaves the site chats' and the web's requests to their own rules", async () => {
    const approval = opened("i-1", { kind: "approval", prompt: "Approve?" });
    expect(await fire(approval, web)).not.toHaveBeenCalled();
  });
});

describe("the browser cap", () => {
  it("counts each browser worker a full chat starts, and stops the eleventh of the day", async () => {
    const { cancel, ctx } = context(full);
    await rootHook.events["task.started"]?.(started("run_browser"), ctx);
    expect(mocks.claimWhatsappBrowserTask).toHaveBeenCalledWith(
      "task-1",
      "better-auth:user-1",
      10
    );
    expect(cancel).not.toHaveBeenCalled();

    mocks.claimWhatsappBrowserTask.mockResolvedValue(false);
    await rootHook.events["task.started"]?.(started("run_browser"), ctx);
    expect(cancel).toHaveBeenCalledOnce();
    expect(takeWhatsappCancelNotice("session-1", "turn-1")).toBe(
      "That's the limit of 10 browser tasks a day on WhatsApp. Continue in assist's web app."
    );
  });

  it("counts nothing else", async () => {
    const { cancel, ctx } = context(full);
    await rootHook.events["task.started"]?.(started("web_search"), ctx);
    const webContext = context(web);
    await rootHook.events["task.started"]?.(
      started("run_browser"),
      webContext.ctx
    );
    expect(mocks.claimWhatsappBrowserTask).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("the browser worker's WhatsApp kill switch", () => {
  const chat = {
    email: "member@example.test",
    endedAt: null,
    id: "00000000-0000-4000-8000-0000000000a1",
    lastSid: `SM${"0".repeat(32)}`,
    lastSidAt: new Date(),
    phone: memberNumber,
    sessionId: "root-session",
    userId: "better-auth:user-1",
    workspaceId,
  };

  async function fireWorker(initiator: Parameters<typeof context>[0]) {
    const { cancel, ctx } = context(initiator, { parentRoot: "root-session" });
    await workerHook.events["model.requested"]?.(
      {
        data: { owner: { turnId: "turn-1" }, runId: "run-1" },
        scope: { runId: "run-1", turnId: "turn-1" },
        type: "model.requested",
      },
      ctx
    );
    return cancel;
  }

  it("stops a worker of a full chat once its member locked WhatsApp, even when the member started it on the web", async () => {
    mocks.whatsappChatOfSession.mockResolvedValue(chat);
    expect(await fireWorker(web)).not.toHaveBeenCalled();

    mocks.whatsappLockOf.mockResolvedValue({ everyone: false, self: true });
    expect(await fireWorker(web)).toHaveBeenCalledOnce();
    expect(await fireWorker(full)).toHaveBeenCalledOnce();
    expect(mocks.whatsappChatOfSession).toHaveBeenCalledWith("root-session");
  });

  it("stops a worker of an ended full chat", async () => {
    mocks.whatsappChatOfSession.mockResolvedValue({
      ...chat,
      endedAt: new Date(),
    });
    expect(await fireWorker(full)).toHaveBeenCalledOnce();
  });

  it("checks a worker a WhatsApp message started from its own principal while its chat has no row", async () => {
    expect(await fireWorker(full)).not.toHaveBeenCalled();

    mocks.whatsappLockOf.mockResolvedValue({ everyone: false, self: true });
    expect(await fireWorker(full)).toHaveBeenCalledOnce();

    mocks.whatsappLockOf.mockRejectedValue(new Error("database down"));
    expect(await fireWorker(full)).toHaveBeenCalledOnce();

    mocks.whatsappChatOfSession.mockRejectedValue(new Error("database down"));
    expect(await fireWorker(full)).toHaveBeenCalledOnce();
  });

  it("leaves a worker of any other chat alone, even when its chat cannot be read", async () => {
    expect(await fireWorker(web)).not.toHaveBeenCalled();
    mocks.whatsappChatOfSession.mockRejectedValue(new Error("database down"));
    expect(await fireWorker(web)).not.toHaveBeenCalled();
  });
});

function opened(
  interactionId: string,
  request: InteractionOpened["data"]["request"]
) {
  return {
    data: { interactionId, request, subject: { turnId: "turn-1" } },
    scope: { turnId: "turn-1" },
    type: "interaction.opened",
  } satisfies InteractionOpened;
}

function started(name: string) {
  return {
    data: {
      kind: "tool",
      name,
      startedBy: { callId: "call-1" },
      taskId: "task-1",
    },
    type: "task.started",
  } satisfies TaskStarted;
}
