import {
  calls,
  emptySessionView,
  failure,
  foldEvents,
  openInteractions,
  session,
  turns,
  type ReceivedEvent,
  type SessionView,
} from "eve/events";
import { z } from "zod";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";

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

// A site task is the first turn of its session: the site's message starts it,
// and eve ends a turn only after every task it started has finished. The
// root agent answers through send_message, so the reply is the text it sent.
export function siteTaskStatus(events: readonly ReceivedEvent[]) {
  const view = foldEvents(emptySessionView(), events);
  const [task] = turns(view);
  const ended = session(view).status === "ended";
  if (!task) return ended ? failed(failedText) : running();
  if (failure(view, task.turnId)) return failed(failedText);
  if (task.status === "settled") {
    if (task.outcome === "completed") {
      return {
        error: null,
        reply: sentText(view, events, task.turnId),
        status: "completed" as const,
      };
    }
    return failed(
      task.outcome === "cancelled" ? "The task was cancelled." : failedText
    );
  }
  if (ended) return failed(failedText);
  const questions = openInteractions(view).map(({ request }) => request.prompt);
  if (questions.length > 0) {
    return {
      error: null,
      reply: questions.join("\n\n"),
      status: "awaiting-input" as const,
    };
  }
  return running();
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

function running() {
  return { error: null, reply: null, status: "running" as const };
}

function failed(error: string) {
  return { error, reply: null, status: "failed" as const };
}
