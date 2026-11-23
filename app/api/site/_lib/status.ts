import {
  calls,
  emptySessionView,
  failure,
  foldEvents,
  interactions,
  openInteractions,
  session,
  turns,
  type ReceivedEvent,
  type SessionView,
} from "eve/events";
import { z } from "zod";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { isSiteCodeQuestion } from "@shared/identity/site-code/question";
import {
  siteTaskEndToolName,
  siteTaskResultSchema,
} from "@shared/identity/site-task/result";

const sentMessageSchema = z.object({
  data: z.object({
    callId: z.string().min(1),
    outcome: z.literal("completed"),
    output: sendMessageOutputSchema,
  }),
  type: z.literal("call.settled"),
});
const endedTaskSchema = z.object({
  data: z.object({
    callId: z.string().min(1),
    outcome: z.literal("completed"),
    output: z.object({ result: siteTaskResultSchema }),
  }),
  type: z.literal("call.settled"),
});

// No site task stays open longer than this, also while it waits for a code.
export const siteTaskLifetimeMs = 45 * 60_000;
const repeatedCodeText =
  "The code sent before could not be used, so a new one is needed.";
const maxQuestionLength = 300;

type SiteTaskError =
  | Exclude<z.infer<typeof siteTaskResultSchema>, "done" | "nothing_found">
  | "cancelled"
  | "needs_person"
  | "timed_out"
  | "usage_limit";

export type SiteTaskState =
  | { readonly status: "running" }
  | {
      readonly interactionId: string;
      readonly question: string;
      readonly status: "awaiting-input";
    }
  | { readonly reply: string | null; readonly status: "completed" }
  | {
      readonly error: SiteTaskError;
      readonly reply: string | null;
      readonly status: "failed";
    };

// Where a site task stands, from its session's events alone, so every read
// agrees. A task whose turn is still open at the end of its lifetime, or ended
// after it, reads timed_out; `openTurn` names a turn that is still open, which
// the API cancels once it reads failed.
export function siteTaskState(
  events: readonly ReceivedEvent[],
  createdAt: Date,
  now: number
) {
  const view = foldEvents(emptySessionView(), events);
  const [task] = turns(view);
  const reached = turnState(view, events);
  const open = isOpen(reached);
  const deadline = createdAt.getTime() + siteTaskLifetimeMs;
  const endedAt = task?.endedAt ? Date.parse(task.endedAt) : Number.NaN;
  const overdue = open ? now >= deadline : endedAt >= deadline;
  return {
    openTurn: open ? task?.turnId : undefined,
    state: overdue ? timedOut(reached) : reached,
  };
}

export function isOpen(state: SiteTaskState) {
  return state.status === "running" || state.status === "awaiting-input";
}

// What a site reads. Whether a completed task found anything comes from the
// files it saved, never from what the agent said.
export function siteTaskStatus(state: SiteTaskState, savedFiles: number) {
  const waiting = state.status === "awaiting-input";
  return {
    error: state.status === "failed" ? state.error : null,
    outcome: state.status === "completed" ? outcomeOf(savedFiles) : null,
    question: waiting ? state.question : null,
    // Tells one question from the next, so a site can see it was asked again.
    questionId: waiting ? state.interactionId : null,
    reply:
      state.status === "completed" || state.status === "failed"
        ? state.reply
        : null,
    status: state.status,
  };
}

function outcomeOf(savedFiles: number) {
  return savedFiles > 0 ? "files" : "nothing_found";
}

// A site task is the first turn of its session: the site's message starts
// it, an answer to its code question resumes it, and eve ends a turn only
// after every task it started has finished. A later turn, such as one the
// owner starts in the chat, is not the site's and never replaces its result.
// The one thing a site can answer is a code question.
function turnState(
  view: SessionView,
  events: readonly ReceivedEvent[]
): SiteTaskState {
  const [task] = turns(view);
  const ended = session(view).status === "ended";
  if (!task) return ended ? failed("failed") : running;
  if (failure(view, task.turnId)) return failed("failed");
  if (task.status === "settled") {
    if (task.outcome === "completed") {
      return completedState(view, events, task.turnId);
    }
    if (task.outcome === "cancelled") {
      return failed(stoppedError(view, task.turnId));
    }
    return failed("failed");
  }
  if (ended) return failed("failed");
  const open = openInteractions(view);
  if (open.some(({ request }) => request.kind === "budget")) {
    return failed("usage_limit");
  }
  if (open.some(({ request }) => !isSiteCodeQuestion(request))) {
    return failed("needs_person");
  }
  // An answer already sent is on its way to the worker.
  const question = open.find(({ answer }) => answer === undefined);
  if (question) {
    // The worker asks again when the website refused the last code or it
    // could not be filled; the site must not take that for the same question.
    const askedBefore = interactions(view).some(
      ({ interactionId, request }) =>
        interactionId !== question.interactionId && isSiteCodeQuestion(request)
    );
    return {
      interactionId: question.interactionId,
      question: plainQuestion(
        askedBefore
          ? `${repeatedCodeText} ${question.request.prompt}`
          : question.request.prompt
      ),
      status: "awaiting-input",
    };
  }
  return running;
}

// The agent ends a site task with the end tool, and its last result decides
// a failure. A turn that ends without the tool completes. When the last code
// question ended without the code reaching the worker, the worker's wait ran
// out, so the task fails whatever result the agent gave other than a failure.
function completedState(
  view: SessionView,
  events: readonly ReceivedEvent[],
  turnId: string
): SiteTaskState {
  const reply = sentText(view, events, turnId);
  const result = endResult(view, events, turnId);
  if (result !== undefined && result !== "done" && result !== "nothing_found") {
    return { error: result, reply, status: "failed" };
  }
  if (lastCodeWentUnused(view, turnId)) {
    return { error: "timed_out", reply, status: "failed" };
  }
  return { reply, status: "completed" };
}

// Read from the events, as the reply is.
function endResult(
  view: SessionView,
  events: readonly ReceivedEvent[],
  turnId: string
) {
  const results = new Map<string, z.infer<typeof siteTaskResultSchema>>();
  for (const event of events) {
    const ended = endedTaskSchema.safeParse(event);
    if (ended.success) {
      results.set(ended.data.data.callId, ended.data.data.output.result);
    }
  }
  return calls(view, { kind: "tool", name: siteTaskEndToolName, turnId })
    .flatMap(({ callId }) => results.get(callId) ?? [])
    .at(-1);
}

function lastCodeWentUnused(view: SessionView, turnId: string) {
  const last = interactions(view).findLast(
    (interaction) =>
      interaction.turnId === turnId && isSiteCodeQuestion(interaction.request)
  );
  return last?.status === "settled" && last.outcome !== "accepted";
}

// A turn the site task hook stopped at a request it cannot answer, or one a
// cancel stopped.
function stoppedError(view: SessionView, turnId: string) {
  const asked = interactions(view).filter(
    (interaction) =>
      interaction.turnId === turnId && !isSiteCodeQuestion(interaction.request)
  );
  if (asked.some(({ request }) => request.kind === "budget")) {
    return "usage_limit";
  }
  return asked.length > 0 ? "needs_person" : "cancelled";
}

// The question comes from the worker's code tool, but it reaches software and
// people outside iCommAssist, so it leaves as one short plain line.
function plainQuestion(prompt: string) {
  const line = prompt
    .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return line.length > maxQuestionLength
    ? `${line.slice(0, maxQuestionLength - 1)}…`
    : line;
}

// The stream carries each settled output in full; the folded view withholds
// large values, so the messages are read from the events themselves.
function sentText(
  view: SessionView,
  events: readonly ReceivedEvent[],
  turnId: string
) {
  const sent = new Map<string, z.infer<typeof sendMessageOutputSchema>>();
  for (const event of events) {
    const message = sentMessageSchema.safeParse(event);
    if (message.success)
      sent.set(message.data.data.callId, message.data.data.output);
  }
  const texts = calls(view, { kind: "tool", name: "send_message", turnId })
    .flatMap(({ callId }) => {
      const message = sent.get(callId);
      if (!message) return [];
      if (message.kind === "link") return [message.url];
      return [
        [message.text, ...(message.attachments ?? []).map(({ url }) => url)]
          .filter((line) => line !== undefined)
          .join("\n"),
      ];
    })
    .filter((text) => text.length > 0);
  return texts.length > 0 ? texts.join("\n\n") : null;
}

function timedOut(state: SiteTaskState): SiteTaskState {
  return failed(
    "timed_out",
    state.status === "completed" || state.status === "failed"
      ? state.reply
      : null
  );
}

const running = { status: "running" } as const;

function failed(error: SiteTaskError, reply: string | null = null) {
  return { error, reply, status: "failed" } as const;
}
