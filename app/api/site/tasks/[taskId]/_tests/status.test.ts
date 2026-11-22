import type { Fact } from "eve/events";
import { describe, expect, it } from "vitest";
import { siteTaskStatus } from "@app/api/site/tasks/[taskId]/_lib/status";
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
      reply: null,
      status: "failed",
    });
  });

  it("awaits input while a question is open, with the question as the reply", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      [
        {
          data: {
            interactionId: "interaction-1",
            request: {
              kind: "question",
              prompt: "Which store should I check?",
            },
            subject: { turnId: "turn_0" },
          },
          scope: { turnId: "turn_0" },
          type: "interaction.opened",
        },
        {
          data: {
            awaiting: [{ interactionId: "interaction-1" }],
            turnId: "turn_0",
          },
          scope: { turnId: "turn_0" },
          type: "turn.paused",
        },
      ],
    ]);

    expect(siteTaskStatus(events)).toEqual({
      error: null,
      reply: "Which store should I check?",
      status: "awaiting-input",
    });
  });
});
