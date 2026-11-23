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

const sentMessageSchema = z.object({
  data: z.object({
    callId: z.string().min(1),
    outcome: z.literal("completed"),
    output: sendMessageOutputSchema,
  }),
  type: z.literal("call.settled"),
});

// Never eve's error message: it can name tools, models or internal paths.
const failedText = "The task failed before it finished.";
const usageLimitText =
  "The task reached its usage limit, so it was stopped before it finished.";
const needsPersonText =
  "The task stopped at a step that needs a person in iCommAssist, which a site cannot answer.";
const maxQuestionLength = 300;

type SiteTaskState =
  | { readonly status: "running" }
  | {
      readonly interactionId: string;
      readonly question: string;
      readonly status: "awaiting-input";
    }
  | { readonly reply: string | null; readonly status: "completed" }
  | { readonly error: string; readonly status: "failed" };

// A site task follows the latest turn of its session: the site's message
// starts the first, and eve ends a turn only after every task it started has
// finished. The root agent answers through send_message, so the reply is the
// text it sent. The one thing a site can answer is a code question.
function siteTaskState(events: readonly ReceivedEvent[]): SiteTaskState {
  const view = foldEvents(emptySessionView(), events);
  const task = turns(view).at(-1);
  const ended = session(view).status === "ended";
  if (!task) return ended ? failed(failedText) : running;
  if (failure(view, task.turnId)) return failed(failedText);
  if (task.status === "settled") {
    if (task.outcome === "completed") {
      return {
        reply: sentText(view, events, task.turnId),
        status: "completed",
      };
    }
    if (task.outcome === "cancelled") {
      return failed(stoppedText(view, task.turnId));
    }
    return failed(failedText);
  }
  if (ended) return failed(failedText);
  const open = openInteractions(view);
  if (open.some(({ request }) => request.kind === "budget")) {
    return failed(usageLimitText);
  }
  if (open.some(({ request }) => !isSiteCodeQuestion(request))) {
    return failed(needsPersonText);
  }
  // An answer already sent is on its way to the worker.
  const question = open.find(({ answer }) => answer === undefined);
  if (question) {
    return {
      interactionId: question.interactionId,
      question: plainQuestion(question.request.prompt),
      status: "awaiting-input",
    };
  }
  return running;
}

export function siteTaskStatus(events: readonly ReceivedEvent[]) {
  const state = siteTaskState(events);
  return {
    error: state.status === "failed" ? state.error : null,
    question: state.status === "awaiting-input" ? state.question : null,
    reply: state.status === "completed" ? state.reply : null,
    status: state.status,
  };
}

// The code question the task waits on, or undefined when it waits on none.
export function awaitedSiteCode(events: readonly ReceivedEvent[]) {
  const state = siteTaskState(events);
  return state.status === "awaiting-input" ? state.interactionId : undefined;
}

// A turn the site task hook stopped at a request it cannot answer.
function stoppedText(view: SessionView, turnId: string) {
  const asked = interactions(view).filter(
    (interaction) =>
      interaction.turnId === turnId && !isSiteCodeQuestion(interaction.request)
  );
  if (asked.some(({ request }) => request.kind === "budget")) {
    return usageLimitText;
  }
  return asked.length > 0 ? needsPersonText : "The task was cancelled.";
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

const running = { status: "running" } as const;

function failed(error: string) {
  return { error, status: "failed" } as const;
}
