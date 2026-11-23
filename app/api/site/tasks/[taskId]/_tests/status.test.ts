import type { Fact } from "eve/events";
import { describe, expect, it } from "vitest";
import {
  awaitedSiteCode,
  siteTaskStatus,
} from "@app/api/site/tasks/[taskId]/_lib/status";
import { eventsOf } from "@tests/helpers/session-view";

const turnStarted: Fact = {
  data: {
    cause: { deliveryId: "delivery-1" },
    follows: null,
    turnId: "turn_0",
  },
  type: "turn.started",
};
// Calls name their model run, and the run names its turn.
const runRequested: Fact = {
  data: { owner: { turnId: "turn_0" }, runId: "run-1" },
  scope: { runId: "run-1", turnId: "turn_0" },
  type: "model.requested",
};

function sendMessage(callId: string, output: Record<string, string>): Fact[] {
  return [
    {
      data: {
        callId,
        capability: { kind: "tool", name: "send_message" },
        input: output,
        owner: { runId: "run-1" },
      },
      scope: { runId: "run-1", turnId: "turn_0" },
      type: "call.requested",
    },
    {
      data: { callId, outcome: "completed", output },
      scope: { runId: "run-1", turnId: "turn_0" },
      type: "call.settled",
    },
  ];
}

function turnSettled(outcome: "cancelled" | "completed" | "failed"): Fact {
  const data = { outcome, turnId: "turn_0" };
  return {
    data:
      outcome === "failed"
        ? {
            ...data,
            error: { code: "MODEL_CALL_FAILED", message: "/srv/internal" },
          }
        : data,
    scope: { turnId: "turn_0" },
    type: "turn.settled",
  };
}

describe("site task status", () => {
  it("is running before the first turn starts", () => {
    expect(siteTaskStatus([])).toEqual({
      error: null,
      question: null,
      reply: null,
      status: "running",
    });
  });

  it("withholds acknowledgements while the turn runs", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      sendMessage("call-ack", { kind: "message", text: "On it." }),
    ]);

    expect(siteTaskStatus(events)).toEqual({
      error: null,
      question: null,
      reply: null,
      status: "running",
    });
  });

  it("replies with the text the agent sent once the turn completes", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      sendMessage("call-1", { kind: "message", text: "pong" }),
      [turnSettled("completed")],
    ]);

    expect(siteTaskStatus(events)).toEqual({
      error: null,
      question: null,
      reply: "pong",
      status: "completed",
    });
  });

  it("joins every message of the turn and keeps replies larger than the folded view", () => {
    const long = "x".repeat(18_000);
    const events = eventsOf([
      [turnStarted, runRequested],
      sendMessage("call-1", { kind: "message", text: long }),
      sendMessage("call-2", { kind: "link", url: "https://example.com/" }),
      [turnSettled("completed")],
    ]);

    expect(siteTaskStatus(events).reply).toBe(
      `${long}\n\nhttps://example.com/`
    );
  });

  it("completes with no reply when the agent sent nothing", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      [turnSettled("completed")],
    ]);

    expect(siteTaskStatus(events)).toEqual({
      error: null,
      question: null,
      reply: null,
      status: "completed",
    });
  });

  it("reports a failed turn without eve's error text", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      [turnSettled("failed")],
    ]);

    expect(siteTaskStatus(events)).toEqual({
      error: "The task failed before it finished.",
      question: null,
      reply: null,
      status: "failed",
    });
    expect(JSON.stringify(siteTaskStatus(events))).not.toContain("/srv");
  });

  it("reports a failed session as failed, though its turn ends cancelled", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      [
        turnSettled("cancelled"),
        {
          data: {
            cause: { turnId: "turn_0" },
            error: { code: "SESSION_FAILED", message: "internal detail" },
            outcome: "failed",
          },
          type: "session.ended",
        },
      ],
    ]);

    expect(siteTaskStatus(events)).toEqual({
      error: "The task failed before it finished.",
      question: null,
      reply: null,
      status: "failed",
    });
  });

  it("reports a cancelled turn as failed", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      [turnSettled("cancelled")],
    ]);

    expect(siteTaskStatus(events)).toEqual({
      error: "The task was cancelled.",
      question: null,
      reply: null,
      status: "failed",
    });
  });

  it("awaits the worker's code question, with the question as plain text", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", 'Enter the code\nfor\u200b "Vendor".'),
    ]);

    expect(siteTaskStatus(events)).toEqual({
      error: null,
      question: 'Enter the code for "Vendor".',
      reply: null,
      status: "awaiting-input",
    });
    expect(awaitedSiteCode(events)).toBe("interaction-1");
  });

  it("caps a long question at 300 characters", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", "x".repeat(400)),
    ]);

    expect(siteTaskStatus(events).question).toBe(`${"x".repeat(299)}…`);
  });

  it("runs again once an answer to the code question is on its way", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", "Enter the code."),
      [
        {
          data: {
            deliveryId: "delivery-2",
            interactionId: "interaction-1",
            responseId: "response-1",
            value: { text: "assist-code.v1.sealed" },
          },
          type: "response.submitted",
        },
      ],
    ]);

    expect(siteTaskStatus(events)).toEqual({
      error: null,
      question: null,
      reply: null,
      status: "running",
    });
    expect(awaitedSiteCode(events)).toBeUndefined();
  });

  it("fails instead of waiting on any other question", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      [
        interactionOpened("interaction-1", {
          kind: "question",
          prompt: "Which store should I check?",
        }),
        turnPaused("interaction-1"),
      ],
    ]);

    expect(siteTaskStatus(events)).toEqual({
      error:
        "The task stopped at a step that needs a person in iCommAssist, which a site cannot answer.",
      question: null,
      reply: null,
      status: "failed",
    });
    expect(awaitedSiteCode(events)).toBeUndefined();
  });

  it("fails at the usage limit's continue prompt instead of waiting", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      [
        interactionOpened("budget-1", {
          kind: "budget",
          options: [
            { id: "continue", label: "Continue" },
            { id: "stop", label: "Stop" },
          ],
          prompt: "This session reached its usage limit. Continue?",
        }),
        turnPaused("budget-1"),
      ],
    ]);

    expect(siteTaskStatus(events)).toEqual({
      error:
        "The task reached its usage limit, so it was stopped before it finished.",
      question: null,
      reply: null,
      status: "failed",
    });
    expect(awaitedSiteCode(events)).toBeUndefined();
  });

  it("explains a turn the site task hook stopped at the usage limit", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      [
        interactionOpened("budget-1", {
          kind: "budget",
          prompt: "This session reached its usage limit. Continue?",
        }),
        turnPaused("budget-1"),
      ],
      [
        {
          data: { interactionId: "budget-1", outcome: "interrupted" },
          type: "interaction.settled",
        },
        turnSettled("cancelled"),
      ],
    ]);

    expect(siteTaskStatus(events).error).toBe(
      "The task reached its usage limit, so it was stopped before it finished."
    );
  });

  it("follows the latest turn of the session", () => {
    const first = [
      [turnStarted, runRequested],
      sendMessage("call-1", { kind: "message", text: "first" }),
      [turnSettled("completed")],
    ];
    const second = [
      [
        {
          data: {
            cause: { deliveryId: "delivery-2" },
            follows: "turn_0",
            turnId: "turn_1",
          },
          type: "turn.started",
        },
        {
          data: { owner: { turnId: "turn_1" }, runId: "run-2" },
          scope: { runId: "run-2", turnId: "turn_1" },
          type: "model.requested",
        },
      ],
    ] satisfies Fact[][];

    expect(siteTaskStatus(eventsOf([...first, ...second])).status).toBe(
      "running"
    );
    expect(
      siteTaskStatus(
        eventsOf([
          ...first,
          ...second,
          [
            {
              data: {
                callId: "call-2",
                capability: { kind: "tool", name: "send_message" },
                input: { kind: "message", text: "second" },
                owner: { runId: "run-2" },
              },
              scope: { runId: "run-2", turnId: "turn_1" },
              type: "call.requested",
            },
            {
              data: {
                callId: "call-2",
                outcome: "completed",
                output: { kind: "message", text: "second" },
              },
              scope: { runId: "run-2", turnId: "turn_1" },
              type: "call.settled",
            },
          ],
          [
            {
              data: { outcome: "completed", turnId: "turn_1" },
              scope: { turnId: "turn_1" },
              type: "turn.settled",
            },
          ],
        ])
      )
    ).toEqual({
      error: null,
      question: null,
      reply: "second",
      status: "completed",
    });
  });
});

type InteractionOpened = Extract<Fact, { type: "interaction.opened" }>;

function interactionOpened(
  interactionId: string,
  request: InteractionOpened["data"]["request"]
): Fact {
  return {
    data: { interactionId, request, subject: { turnId: "turn_0" } },
    scope: { turnId: "turn_0" },
    type: "interaction.opened",
  };
}

function turnPaused(interactionId: string): Fact {
  return {
    data: { awaiting: [{ interactionId }], turnId: "turn_0" },
    scope: { turnId: "turn_0" },
    type: "turn.paused",
  };
}

// The worker's question, relayed to the root session.
function codeQuestion(interactionId: string, prompt: string): Fact[] {
  return [
    {
      data: {
        interactionId,
        origin: {
          call: { callId: "worker-call-1", name: "fill_code_from_site" },
          interactionId,
          sessionId: "worker-session-1",
        },
        request: {
          allowFreeform: true,
          display: "text",
          kind: "question",
          prompt,
          title: "One-time code",
        },
        subject: { turnId: "turn_0" },
      },
      scope: { turnId: "turn_0" },
      type: "interaction.opened",
    },
    turnPaused(interactionId),
  ];
}
