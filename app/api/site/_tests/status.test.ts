import type { Fact, ReceivedEvent } from "eve/events";
import { describe, expect, it } from "vitest";
import { siteTaskState, siteTaskStatus } from "@app/api/site/_lib/status";
import { eventsOf } from "@tests/helpers/session-view";

// eventsOf stamps every line at this time, when the task was created.
const createdAt = new Date("2026-01-01T00:00:00.000Z");
const minute = 60_000;

function statusOf(
  events: readonly ReceivedEvent[],
  {
    now = createdAt.getTime() + minute,
    savedFiles = 0,
    signInOrigin = null,
  }: {
    readonly now?: number;
    readonly savedFiles?: number;
    readonly signInOrigin?: string | null;
  } = {}
) {
  return siteTaskStatus(
    siteTaskState(events, createdAt, now).state,
    savedFiles,
    signInOrigin
  );
}

// A look's status, a minute in; the files counted must not change it.
function lookStatusOf(events: readonly ReceivedEvent[], savedFiles: number) {
  return siteTaskStatus(
    siteTaskState(events, createdAt, createdAt.getTime() + minute, "look")
      .state,
    savedFiles,
    null,
    "look"
  );
}

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

function toolCall(
  callId: string,
  name: string,
  output: Record<string, string>,
  { outcome = "completed", run = "run-1", turn = "turn_0" } = {}
): Fact[] {
  return [
    {
      data: {
        callId,
        capability: { kind: "tool", name },
        input: output,
        owner: { runId: run },
      },
      scope: { runId: run, turnId: turn },
      type: "call.requested",
    },
    outcome === "completed"
      ? {
          data: { callId, outcome: "completed", output },
          scope: { runId: run, turnId: turn },
          type: "call.settled",
        }
      : {
          data: {
            callId,
            error: { code: "TOOL_FAILED", message: "failed" },
            outcome: "failed",
          },
          scope: { runId: run, turnId: turn },
          type: "call.settled",
        },
  ];
}

function sendMessage(callId: string, output: Record<string, string>) {
  return toolCall(callId, "send_message", output);
}

function endTask(callId: string, result: string, options = {}) {
  return toolCall(callId, "end_site_task", { result }, options);
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

const idle = {
  error: null,
  outcome: null,
  question: null,
  questionId: null,
  reply: null,
  signInOrigin: null,
  status: "running",
};

describe("site look status", () => {
  it.each([
    ["done", "listed"],
    ["nothing_found", "nothing_found"],
  ] as const)(
    "reads a look the agent ended %s as %s, whatever files it counts",
    (result, outcome) => {
      const events = eventsOf([
        [turnStarted, runRequested],
        sendMessage("call-1", { kind: "message", text: "INV-1 20.00 USD" }),
        endTask("call-2", result),
        [turnSettled("completed")],
      ]);

      expect(lookStatusOf(events, 3)).toMatchObject({
        outcome,
        reply: "INV-1 20.00 USD",
        status: "completed",
      });
    }
  );

  it("reads a look the agent never ended as failed, keeping its reply, never as a list", () => {
    const reply = "I could not sign in, the site showed a bot check.";
    const events = eventsOf([
      [turnStarted, runRequested],
      sendMessage("call-1", { kind: "message", text: reply }),
      [turnSettled("completed")],
    ]);

    expect(lookStatusOf(events, 0)).toMatchObject({
      error: "failed",
      outcome: null,
      reply,
      status: "failed",
    });
    // A fetch the agent never ended still reads by its files.
    expect(statusOf(events)).toMatchObject({
      outcome: "nothing_found",
      status: "completed",
    });
  });

  it("fails a look as a fetch fails", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      endTask("call-1", "login_failed"),
      [turnSettled("completed")],
    ]);

    expect(lookStatusOf(events, 0)).toMatchObject({
      error: "login_failed",
      outcome: null,
      status: "failed",
    });
  });
});

describe("site task status", () => {
  it("is running before the first turn starts", () => {
    expect(statusOf([])).toEqual(idle);
  });

  it("withholds acknowledgements while the turn runs", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      sendMessage("call-ack", { kind: "message", text: "On it." }),
    ]);

    expect(statusOf(events)).toEqual(idle);
  });

  it("replies with the text the agent sent once the turn completes, having found nothing without files", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      sendMessage("call-1", { kind: "message", text: "pong" }),
      [turnSettled("completed")],
    ]);

    expect(statusOf(events)).toEqual({
      error: null,
      outcome: "nothing_found",
      question: null,
      questionId: null,
      reply: "pong",
      signInOrigin: null,
      status: "completed",
    });
  });

  it("replies with the turn's last message, kept whole when the folded view withholds it", () => {
    const long = "x".repeat(18_000);
    const events = eventsOf([
      [turnStarted, runRequested],
      sendMessage("call-1", { kind: "message", text: "First draft." }),
      sendMessage("call-2", { kind: "message", text: long }),
      [turnSettled("completed")],
    ]);
    const linked = eventsOf([
      [turnStarted, runRequested],
      sendMessage("call-1", { kind: "message", text: long }),
      sendMessage("call-2", { kind: "link", url: "https://example.com/" }),
      [turnSettled("completed")],
    ]);

    expect(statusOf(events).reply).toBe(long);
    expect(statusOf(linked).reply).toBe("https://example.com/");
  });

  it("completes with no reply when the agent sent nothing", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      [turnSettled("completed")],
    ]);

    expect(statusOf(events)).toEqual({
      ...idle,
      outcome: "nothing_found",
      status: "completed",
    });
  });

  it("reports a failed turn as failed, without eve's error text", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      [turnSettled("failed")],
    ]);

    expect(statusOf(events)).toEqual({
      ...idle,
      error: "failed",
      status: "failed",
    });
    expect(JSON.stringify(statusOf(events))).not.toContain("/srv");
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

    expect(statusOf(events)).toEqual({
      ...idle,
      error: "failed",
      status: "failed",
    });
  });

  it("reports a session that ended before its turn as failed", () => {
    const events = eventsOf([
      [
        {
          data: { outcome: "completed" },
          type: "session.ended",
        },
      ],
    ]);

    expect(statusOf(events)).toMatchObject({
      error: "failed",
      status: "failed",
    });
  });

  it("reports a cancelled turn as cancelled", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      [turnSettled("cancelled")],
    ]);

    expect(statusOf(events)).toEqual({
      ...idle,
      error: "cancelled",
      status: "failed",
    });
  });

  it("awaits the worker's code question, with the question as plain text", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", 'Enter the code\nfor​ "Vendor".'),
    ]);

    expect(statusOf(events)).toEqual({
      ...idle,
      question: 'Enter the code for "Vendor".',
      questionId: "interaction-1",
      status: "awaiting-input",
    });
  });

  it("caps a long question at 300 characters", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", "x".repeat(400)),
    ]);

    expect(statusOf(events).question).toBe(`${"x".repeat(299)}…`);
  });

  it("runs again once an answer to the code question is on its way", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", "Enter the code."),
      [codeAnswer("interaction-1")],
    ]);

    expect(statusOf(events)).toEqual(idle);
  });

  it("fails as needing a person instead of waiting on any other question", () => {
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

    expect(statusOf(events)).toEqual({
      ...idle,
      error: "needs_person",
      status: "failed",
    });
  });

  it("fails at the usage limit's continue prompt instead of waiting", () => {
    const events = eventsOf([[turnStarted, runRequested], budgetPrompt()]);

    expect(statusOf(events)).toEqual({
      ...idle,
      error: "usage_limit",
      status: "failed",
    });
  });

  it("explains a turn the site task hook stopped at the usage limit or another question", () => {
    const stopped = (opened: Fact[]) =>
      eventsOf([
        [turnStarted, runRequested],
        opened,
        [
          {
            data: { interactionId: "interaction-1", outcome: "interrupted" },
            type: "interaction.settled",
          },
          turnSettled("cancelled"),
        ],
      ]);

    expect(statusOf(stopped(budgetPrompt())).error).toBe("usage_limit");
    expect(
      statusOf(
        stopped([
          interactionOpened("interaction-1", {
            kind: "approval",
            prompt: "Create this scheduled job?",
          }),
          turnPaused("interaction-1"),
        ])
      ).error
    ).toBe("needs_person");
  });

  it("tells a question asked again from the first, by id and by wording", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", "Enter the code."),
      [codeAnswer("interaction-1"), codeSettled("interaction-1", "accepted")],
      codeQuestion("interaction-2", "Enter the code."),
    ]);

    expect(statusOf(events)).toMatchObject({
      question:
        "The code sent before could not be used, so a new one is needed. Enter the code.",
      questionId: "interaction-2",
      status: "awaiting-input",
    });
  });

  it("keeps the site's result when the owner starts another turn in the chat", () => {
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

    expect(statusOf(eventsOf([...first, ...second]))).toMatchObject({
      reply: "first",
      status: "completed",
    });
    expect(
      statusOf(
        eventsOf([
          ...first,
          ...second,
          toolCall(
            "call-2",
            "send_message",
            { kind: "message", text: "second" },
            { run: "run-2", turn: "turn_1" }
          ),
          endTask("call-3", "login_failed", { run: "run-2", turn: "turn_1" }),
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
      ...idle,
      outcome: "nothing_found",
      reply: "first",
      status: "completed",
    });
  });
});

describe("site task end result", () => {
  it.each(["login_failed", "code_failed", "blocked", "off_site", "failed"])(
    "fails a task the agent ended with %s, under that error code",
    (result) => {
      const events = eventsOf([
        [turnStarted, runRequested],
        sendMessage("call-1", { kind: "message", text: "Could not sign in." }),
        endTask("call-2", result),
        [turnSettled("completed")],
      ]);

      expect(statusOf(events, { savedFiles: 2 })).toEqual({
        ...idle,
        error: result,
        reply: "Could not sign in.",
        status: "failed",
      });
    }
  );

  it("fails a task the agent ended with sign_in_elsewhere with the page the server recorded", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      sendMessage("call-1", { kind: "message", text: "Signs in elsewhere." }),
      endTask("call-2", "sign_in_elsewhere"),
      [turnSettled("completed")],
    ]);

    expect(
      statusOf(events, { signInOrigin: "https://auth.vendor.example" })
    ).toEqual({
      ...idle,
      error: "sign_in_elsewhere",
      reply: "Signs in elsewhere.",
      signInOrigin: "https://auth.vendor.example",
      status: "failed",
    });
    // Without a page the server recorded, the agent's word alone reads as a
    // refused sign-in.
    expect(statusOf(events)).toEqual({
      ...idle,
      error: "login_failed",
      reply: "Signs in elsewhere.",
      status: "failed",
    });
  });

  it.each(["done", "login_failed", "off_site"])(
    "names no sign-in page for a task the agent ended with %s, though one was recorded",
    (result) => {
      const events = eventsOf([
        [turnStarted, runRequested],
        endTask("call-1", result),
        [turnSettled("completed")],
      ]);

      expect(
        statusOf(events, { signInOrigin: "https://auth.vendor.example" })
      ).toMatchObject({ signInOrigin: null });
    }
  );

  it("times out a sign_in_elsewhere reached after the lifetime, naming no page", () => {
    const deadline = createdAt.getTime() + 45 * minute;
    const events = timedEvents([
      [createdAt.getTime(), [turnStarted, runRequested]],
      [deadline + 1000, endTask("call-1", "sign_in_elsewhere")],
      [deadline + 1000, [turnSettled("completed")]],
    ]);

    expect(
      siteTaskStatus(
        siteTaskState(events, createdAt, deadline + minute).state,
        0,
        "https://auth.vendor.example"
      )
    ).toMatchObject({ error: "timed_out", signInOrigin: null });
  });

  it.each(["done", "nothing_found"])(
    "completes a task the agent ended with %s, finding files only when it saved some",
    (result) => {
      const events = eventsOf([
        [turnStarted, runRequested],
        endTask("call-1", result),
        [turnSettled("completed")],
      ]);

      expect(statusOf(events, { savedFiles: 0 })).toMatchObject({
        error: null,
        outcome: "nothing_found",
        status: "completed",
      });
      expect(statusOf(events, { savedFiles: 2 })).toMatchObject({
        error: null,
        outcome: "files",
        status: "completed",
      });
    }
  );

  it("maps the agent's last result and ignores a call that failed", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      endTask("call-1", "blocked"),
      endTask("call-2", "done"),
      endTask("call-3", "login_failed", { outcome: "failed" }),
      [turnSettled("completed")],
    ]);

    expect(statusOf(events)).toMatchObject({
      error: null,
      status: "completed",
    });
    expect(
      statusOf(
        eventsOf([
          [turnStarted, runRequested],
          endTask("call-1", "done"),
          endTask("call-2", "off_site"),
          [turnSettled("completed")],
        ])
      ).error
    ).toBe("off_site");
  });

  it("ignores a result that is not one of the tool's", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      endTask("call-1", "succeeded"),
      [turnSettled("completed")],
    ]);

    expect(statusOf(events)).toMatchObject({ status: "completed" });
  });

  it("reads no result before the turn ends", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      endTask("call-1", "login_failed"),
    ]);

    expect(statusOf(events)).toEqual(idle);
  });
});

describe("site task code wait", () => {
  const waitedOut = (...end: Fact[][]) =>
    eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", "Enter the code."),
      [codeSettled("interaction-1", "withdrawn")],
      ...end,
      [turnSettled("completed")],
    ]);

  it("fails as timed out when no code reached the worker, whatever else the agent said", () => {
    expect(statusOf(waitedOut())).toMatchObject({
      error: "timed_out",
      outcome: null,
      status: "failed",
    });
    expect(
      statusOf(waitedOut(endTask("call-1", "done")), { savedFiles: 1 })
    ).toMatchObject({ error: "timed_out", status: "failed" });
    expect(
      statusOf(waitedOut(endTask("call-1", "nothing_found")))
    ).toMatchObject({ error: "timed_out", status: "failed" });
  });

  it("reads timed out for a code that did not arrive, also when the agent called it code_failed", () => {
    expect(statusOf(waitedOut(endTask("call-1", "code_failed")))).toMatchObject(
      { error: "timed_out", status: "failed" }
    );
  });

  it("keeps another failure the agent chose after the code wait", () => {
    for (const result of ["blocked", "login_failed", "off_site", "failed"]) {
      expect(statusOf(waitedOut(endTask("call-1", result)))).toMatchObject({
        error: result,
        status: "failed",
      });
    }
  });

  it("keeps code_failed for a code that reached the worker", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", "Enter the code."),
      [codeAnswer("interaction-1"), codeSettled("interaction-1", "accepted")],
      endTask("call-1", "code_failed"),
      [turnSettled("completed")],
    ]);

    expect(statusOf(events)).toMatchObject({
      error: "code_failed",
      status: "failed",
    });
  });

  it("keeps code_failed when a code reached the worker and the second ask then ran out", () => {
    const askedAgain = (...end: Fact[][]) =>
      eventsOf([
        [turnStarted, runRequested],
        codeQuestion("interaction-1", "Enter the code."),
        [codeAnswer("interaction-1"), codeSettled("interaction-1", "accepted")],
        codeQuestion("interaction-2", "Enter the code."),
        [codeSettled("interaction-2", "withdrawn")],
        ...end,
        [turnSettled("completed")],
      ]);

    // The website refused the first code, or it could not be typed.
    expect(
      statusOf(askedAgain(endTask("call-1", "code_failed")))
    ).toMatchObject({ error: "code_failed", status: "failed" });
    // Any other end still reads the wait that ran out.
    expect(statusOf(askedAgain(endTask("call-1", "done")))).toMatchObject({
      error: "timed_out",
      status: "failed",
    });
    expect(statusOf(askedAgain())).toMatchObject({
      error: "timed_out",
      status: "failed",
    });
  });

  it("reads timed out for code_failed when neither of two asks got a code", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", "Enter the code."),
      [codeAnswer("interaction-1"), codeSettled("interaction-1", "withdrawn")],
      codeQuestion("interaction-2", "Enter the code."),
      [codeSettled("interaction-2", "withdrawn")],
      endTask("call-1", "code_failed"),
      [turnSettled("completed")],
    ]);

    expect(statusOf(events)).toMatchObject({
      error: "timed_out",
      status: "failed",
    });
  });

  it("completes when a later code reached the worker", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", "Enter the code."),
      [codeSettled("interaction-1", "withdrawn")],
      codeQuestion("interaction-2", "Enter the code."),
      [codeAnswer("interaction-2"), codeSettled("interaction-2", "accepted")],
      endTask("call-1", "done"),
      [turnSettled("completed")],
    ]);

    expect(statusOf(events, { savedFiles: 1 })).toMatchObject({
      outcome: "files",
      status: "completed",
    });
  });

  it("counts a code that decided its question as used, whatever outcome eve gave", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", "Enter the code."),
      [
        codeAnswer("interaction-1"),
        {
          data: {
            cause: { responseId: "response-interaction-1" },
            interactionId: "interaction-1",
            outcome: "invalid",
            response: { text: "assist-code.v1.sealed" },
          },
          type: "interaction.settled",
        },
      ],
      endTask("call-1", "done"),
      [turnSettled("completed")],
    ]);

    expect(statusOf(events)).toMatchObject({ status: "completed" });
  });

  it("fails as timed out when the delivered code was settled without being taken", () => {
    const events = eventsOf([
      [turnStarted, runRequested],
      codeQuestion("interaction-1", "Enter the code."),
      [codeAnswer("interaction-1"), codeSettled("interaction-1", "withdrawn")],
      [turnSettled("completed")],
    ]);

    expect(statusOf(events).error).toBe("timed_out");
  });
});

describe("site task lifetime", () => {
  const deadline = createdAt.getTime() + 45 * minute;

  it("names the open turn while the task runs inside its lifetime", () => {
    const events = eventsOf([[turnStarted, runRequested]]);

    expect(siteTaskState(events, createdAt, deadline - 1)).toEqual({
      openTurn: "turn_0",
      state: { status: "running" },
    });
  });

  it.each([
    ["runs", [[turnStarted, runRequested]]],
    [
      "waits for a code",
      [[turnStarted, runRequested], codeQuestion("interaction-1", "Code?")],
    ],
  ] satisfies [string, Fact[][]][])(
    "times out a task that still %s at 45 minutes, naming the turn to cancel",
    (_case, lines) => {
      const read = siteTaskState(eventsOf(lines), createdAt, deadline);

      expect(read.openTurn).toBe("turn_0");
      expect(siteTaskStatus(read.state, 0, null)).toEqual({
        ...idle,
        error: "timed_out",
        status: "failed",
      });
    }
  );

  it("times out a task that has no turn yet at 45 minutes, with no turn to cancel", () => {
    expect(siteTaskState([], createdAt, deadline)).toEqual({
      openTurn: undefined,
      state: { error: "timed_out", reply: null, status: "failed" },
    });
  });

  it("keeps reading timed out once the cancel has ended the turn after its lifetime", () => {
    const events = timedEvents([
      [createdAt.getTime(), [turnStarted, runRequested]],
      [deadline + 2000, [turnSettled("cancelled")]],
    ]);

    expect(siteTaskState(events, createdAt, deadline + 5000)).toEqual({
      openTurn: undefined,
      state: { error: "timed_out", reply: null, status: "failed" },
    });
  });

  it("times out a turn that completed after its lifetime, keeping its reply", () => {
    const events = timedEvents([
      [createdAt.getTime(), [turnStarted, runRequested]],
      [
        deadline + 1000,
        sendMessage("call-1", { kind: "message", text: "Found it." }),
      ],
      [deadline + 1000, endTask("call-2", "done")],
      [deadline + 1000, [turnSettled("completed")]],
    ]);

    expect(
      siteTaskStatus(
        siteTaskState(events, createdAt, deadline + 60 * minute).state,
        3,
        null
      )
    ).toEqual({
      ...idle,
      error: "timed_out",
      reply: "Found it.",
      status: "failed",
    });
  });

  it("keeps a result reached inside the lifetime, read at any time later", () => {
    const cancelled = timedEvents([
      [createdAt.getTime(), [turnStarted, runRequested]],
      [deadline - 1000, [turnSettled("cancelled")]],
    ]);
    const completed = timedEvents([
      [createdAt.getTime(), [turnStarted, runRequested]],
      [deadline - 1000, endTask("call-1", "done")],
      [deadline - 1000, [turnSettled("completed")]],
    ]);
    const later = deadline + 24 * 60 * minute;

    expect(siteTaskState(cancelled, createdAt, later).state).toEqual({
      error: "cancelled",
      reply: null,
      status: "failed",
    });
    expect(
      siteTaskStatus(siteTaskState(completed, createdAt, later).state, 1, null)
    ).toMatchObject({ outcome: "files", status: "completed" });
  });
});

// Each line at its own time, as eve's stream stamps it.
function timedEvents(
  lines: readonly (readonly [number, readonly Fact[]])[]
): ReceivedEvent[] {
  return lines.flatMap(([at, facts], line) =>
    facts.map((fact, index) => ({
      ...fact,
      meta: {
        at: new Date(at).toISOString(),
        endOfLine: index === facts.length - 1,
        position: { index, line },
      },
    }))
  );
}

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

function budgetPrompt(): Fact[] {
  return [
    interactionOpened("interaction-1", {
      kind: "budget",
      options: [
        { id: "continue", label: "Continue" },
        { id: "stop", label: "Stop" },
      ],
      prompt: "This session reached its usage limit. Continue?",
    }),
    turnPaused("interaction-1"),
  ];
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

function codeAnswer(interactionId: string): Fact {
  return {
    data: {
      deliveryId: `delivery-${interactionId}`,
      interactionId,
      responseId: `response-${interactionId}`,
      value: { text: "assist-code.v1.sealed" },
    },
    type: "response.submitted",
  };
}

function codeSettled(
  interactionId: string,
  outcome: "accepted" | "withdrawn"
): Fact {
  return {
    data: { interactionId, outcome },
    type: "interaction.settled",
  };
}
