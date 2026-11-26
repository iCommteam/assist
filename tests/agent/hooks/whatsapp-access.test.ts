import type { InteractionOpened, TaskStarted, TurnStarted } from "eve/events";
import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { enrolledTeamMemberId } from "@db/services/auth/allowlist";
import type {
  claimWhatsappBrowserTask,
  whatsappChatOfSession,
  whatsappLockOf,
} from "@db/services/whatsapp";
import type {
  linkedWhatsappMemberOf,
  linkedWhatsappNumberOf,
} from "@db/services/whatsapp-links";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { hookContextFor } from "@tests/helpers/hook-context";
import { viewOf } from "@tests/helpers/session-view";

const mocks = vi.hoisted(() => ({
  claimWhatsappBrowserTask: vi.fn<typeof claimWhatsappBrowserTask>(),
  enrolledTeamMemberId: vi.fn<typeof enrolledTeamMemberId>(),
  linkedWhatsappMemberOf: vi.fn<typeof linkedWhatsappMemberOf>(),
  linkedWhatsappNumberOf: vi.fn<typeof linkedWhatsappNumberOf>(),
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
// The numbers members linked themselves, faked: none unless a case links one.
vi.mock("@db/services/whatsapp-links", () => ({
  linkedWhatsappMemberOf: mocks.linkedWhatsappMemberOf,
  linkedWhatsappNumberOf: mocks.linkedWhatsappNumberOf,
}));
vi.mock("@shared/environment", () => ({
  env: {},
  whatsappNumbersVariable: () => mocks.numbers,
}));
vi.mock("@shared/environment/origin", () => ({
  applicationOrigin: () => "https://assist.example.test",
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
  mocks.linkedWhatsappMemberOf.mockResolvedValue(undefined);
  mocks.linkedWhatsappNumberOf.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

// The member linked their number themselves; the list names nobody.
function linkMemberNumber() {
  mocks.numbers = "";
  mocks.linkedWhatsappMemberOf.mockImplementation(async (phone) =>
    phone === memberNumber
      ? {
          email: "Member@Example.test",
          id: "00000000-0000-4000-8000-000000000001",
          userId: "user-1",
        }
      : undefined
  );
  mocks.linkedWhatsappNumberOf.mockImplementation(async (email) =>
    email === "member@example.test"
      ? {
          id: "00000000-0000-4000-8000-000000000001",
          linkedAt: new Date(),
          phone: memberNumber,
          userId: "user-1",
        }
      : undefined
  );
}

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

  it("gives a number the member linked exactly the access of a listed one", async () => {
    linkMemberNumber();
    expect(await fireRootTurn(full)).not.toHaveBeenCalled();
    expect(await fireRootTurn(narrow)).not.toHaveBeenCalled();

    mocks.whatsappLockOf.mockResolvedValue({ everyone: false, self: true });
    expect(await fireRootTurn(full)).toHaveBeenCalledOnce();
    expect(await fireRootTurn(narrow)).not.toHaveBeenCalled();

    mocks.whatsappLockOf.mockResolvedValue({ everyone: false, self: false });
    mocks.enrolledTeamMemberId.mockResolvedValue(undefined);
    expect(await fireRootTurn(full)).toHaveBeenCalledOnce();
  });

  it("stops a linked number's chats once the link is gone, or the list sets the number for someone else", async () => {
    linkMemberNumber();
    mocks.numbers = `${memberNumber}=other@example.test`;
    expect(await fireRootTurn(full)).toHaveBeenCalledOnce();

    mocks.numbers = "";
    mocks.linkedWhatsappMemberOf.mockResolvedValue(undefined);
    mocks.linkedWhatsappNumberOf.mockResolvedValue(undefined);
    expect(await fireRootTurn(full)).toHaveBeenCalledOnce();
    expect(await fireRootTurn(narrow)).toHaveBeenCalledOnce();
  });

  it("stops a full chat when its linked number cannot be read", async () => {
    linkMemberNumber();
    mocks.linkedWhatsappMemberOf.mockRejectedValue(new Error("database down"));
    expect(await fireRootTurn(full)).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      "[whatsapp] access could not be read",
      { error: "Error" }
    );
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

  it("lets a full chat's approval through, for the channel to draw as a numbered message, and still stops a narrow chat's", async () => {
    const approval = opened("i-1", {
      kind: "approval",
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
      prompt: "Send this email?",
    });
    expect(await fire(approval, full)).not.toHaveBeenCalled();
    expect(takeWhatsappCancelNotice("session-1", "turn-1")).toBeUndefined();

    expect(await fire(approval, narrow)).toHaveBeenCalledOnce();
    expect(takeWhatsappCancelNotice("session-1", "turn-1")).toBe(
      "That step can't be done on WhatsApp. Continue in assist's web app."
    );
  });

  it("stops a full chat at an approval the channel cannot draw as one message, unless the turn was typed on the web, which shows it there", async () => {
    const undrawable = [
      `Send this email?\n\nTo: ana@example.test\n\n${"x".repeat(1600)}`,
      "Start this browser task?\n\nLook it up.\n\nReply 1 to approve or 2 to decline.",
    ];
    for (const prompt of undrawable) {
      const approval = opened("i-1", { kind: "approval", prompt });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each approval is checked on its own.
      expect(await fire(approval, full)).toHaveBeenCalledOnce();
      expect(takeWhatsappCancelNotice("session-1", "turn-1")).toBe(
        "That step can't be approved on WhatsApp. Continue in assist's web app."
      );

      const { cancel, ctx } = context(full, { view: viewOf([[approval]]) });
      const webTurn = {
        ...ctx,
        session: { ...ctx.session, auth: { current: web, initiator: full } },
      };
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each approval is checked on its own.
      await rootHook.events["interaction.opened"]?.(approval, webTurn);
      expect(cancel).not.toHaveBeenCalled();
    }
  });

  it("stops at a sign-in, which WhatsApp cannot show, and sends a full chat's member to the Workspace page to reconnect Google", async () => {
    const google = opened("i-1", {
      kind: "sign-in",
      prompt: "Connect Google to continue.",
      signIn: { displayName: "Google", name: "google" },
    });
    expect(await fire(google, full)).toHaveBeenCalledOnce();
    expect(takeWhatsappCancelNotice("session-1", "turn-1")).toBe(
      "Google needs you to connect it again. Press Reconnect under Connectors on assist's Workspace page:\nhttps://assist.example.test/"
    );

    const other = opened("i-2", {
      kind: "sign-in",
      prompt: "Connect your account.",
    });
    expect(await fire(other, full)).toHaveBeenCalledOnce();
    expect(takeWhatsappCancelNotice("session-1", "turn-1")).toBe(
      "That step can't be done on WhatsApp. Continue in assist's web app."
    );
    expect(await fire(google, narrow)).toHaveBeenCalledOnce();
    expect(takeWhatsappCancelNotice("session-1", "turn-1")).toBe(
      "That step can't be done on WhatsApp. Continue in assist's web app."
    );
  });

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

  it("keeps a worker of a linked number's full chat going until the link is gone", async () => {
    linkMemberNumber();
    mocks.whatsappChatOfSession.mockResolvedValue(chat);
    expect(await fireWorker(web)).not.toHaveBeenCalled();

    mocks.linkedWhatsappMemberOf.mockResolvedValue(undefined);
    expect(await fireWorker(web)).toHaveBeenCalledOnce();
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
