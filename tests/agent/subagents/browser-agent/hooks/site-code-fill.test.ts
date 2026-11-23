import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallSettled, Fact, InteractionSettled } from "eve/events";
import siteCodeFill from "@agent/subagents/browser-agent/hooks/site-code-fill";
import { traceTimelineRows } from "@agent/subagents/browser-agent/lib/trace/timeline";
import {
  forgetFilledBrowser,
  redactBrowserOutput,
} from "@agent/subagents/browser-agent/lib/autofill/redaction";
import { hookContextFor } from "@tests/helpers/hook-context";
import { resetEveState } from "@tests/helpers/eve-state";
import { viewOf } from "@tests/helpers/session-view";

vi.mock("eve/context", () => import("@tests/helpers/eve-state"));

const turnFacts: Fact[] = [
  {
    data: { cause: { deliveryId: "d-1" }, follows: null, turnId: "turn-1" },
    type: "turn.started",
  },
  {
    data: { owner: { turnId: "turn-1" }, runId: "run-1" },
    scope: { runId: "run-1", turnId: "turn-1" },
    type: "model.requested",
  },
];

function codeCall(output: { filled: boolean; message: string }) {
  const settled: CallSettled = {
    data: { callId: "call-1", outcome: "completed", output },
    scope: { runId: "run-1", turnId: "turn-1" },
    type: "call.settled",
  };
  const view = viewOf([
    turnFacts,
    [
      {
        data: {
          callId: "call-1",
          capability: { kind: "tool", name: "fill_code_from_site" },
          input: { browserSessionId: "browser-1", sentBy: "email" },
          owner: { runId: "run-1" },
        },
        scope: { runId: "run-1", turnId: "turn-1" },
        type: "call.requested",
      },
      settled,
    ],
  ]);
  return { settled, view };
}

beforeEach(() => {
  resetEveState();
  forgetFilledBrowser("browser-1");
});

describe("site code fill hook", () => {
  it("strips rendered values in the browser once the relayed code is filled", async () => {
    const { settled, view } = codeCall({ filled: true, message: "Filled." });

    await siteCodeFill.events["call.settled"]?.(
      settled,
      hookContextFor({ sessionId: "worker-1", view })
    );

    // Even after a restart forgets the code, a snapshot of the filled page
    // shows no field value.
    expect(
      redactBrowserOutput("worker-1", "browser-1", 'textbox value="482913"')
    ).toBe('textbox value="[hidden]"');
  });

  it("marks nothing when no code was filled", async () => {
    const { settled, view } = codeCall({ filled: false, message: "No code." });

    await siteCodeFill.events["call.settled"]?.(
      settled,
      hookContextFor({ sessionId: "worker-1", view })
    );

    expect(
      redactBrowserOutput("worker-1", "browser-1", 'textbox value="mugs"')
    ).toBe('textbox value="mugs"');
  });
});

describe("site code question in the browser trace", () => {
  it("records only the outcome of the answer, never its text", () => {
    const view = viewOf([
      turnFacts,
      [
        {
          data: {
            interactionId: "interaction-1",
            request: {
              allowFreeform: true,
              display: "text",
              kind: "question",
              prompt: "Enter the one-time code.",
              title: "One-time code",
            },
            subject: { turnId: "turn-1" },
          },
          scope: { turnId: "turn-1" },
          type: "interaction.opened",
        },
      ],
    ]);
    const settled: InteractionSettled = {
      data: {
        interactionId: "interaction-1",
        outcome: "accepted",
        response: { text: "assist-code.v1.sealed" },
      },
      type: "interaction.settled",
    };

    const rows = traceTimelineRows(settled, {
      now: new Date("2026-11-23T00:00:00.000Z"),
      position: { index: 0, line: 3 },
      view,
    });

    expect(rows).toEqual([
      expect.objectContaining({ detail: "accepted", label: "Input resolved" }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("assist-code");
  });
});
