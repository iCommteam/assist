import { emptySessionView, foldEvents, openInteractions } from "eve/events";
import { z } from "zod";
import { siteUserSchema } from "@shared/identity/site-credential";
import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";
import { readSiteJsonBody } from "@app/api/site/_lib/request-body";
import { siteEveClient } from "@app/api/site/_lib/eve";
import { oneAtATime } from "@app/api/site/_lib/one-at-a-time";
import {
  callChatEve,
  chatGrant,
  keepSiteChatToken,
  lookupSiteChat,
  readSiteChatEvents,
  teemiqTokenSchema,
  type SiteChat,
} from "@app/api/site/chats/_lib/chat";

const maxBodyBytes = 16 * 1024;
const answerInputSchema = z.union([
  z.object({
    interactionId: z.string().min(1).max(512),
    optionId: z.string().min(1).max(512),
    siteUser: siteUserSchema,
    teemiqToken: teemiqTokenSchema,
  }),
  z.object({
    interactionId: z.string().min(1).max(512),
    siteUser: siteUserSchema,
    teemiqToken: teemiqTokenSchema,
    text: z
      .string()
      .min(1)
      .max(8000)
      .refine((text) => text.trim().length > 0),
  }),
]);
// Serializes the answers of a chat, so a doubled delivery finds the question
// answered and gets 409 instead of a second answer.
const answersInFlight = new Map<string, Promise<Response>>();

type AnswerInput = z.infer<typeof answerInputSchema>;

// Answers the chat's open question, by one of its options or in words.
export async function POST(
  request: Request,
  context: RouteContext<"/api/site/chats/[chatId]/answers">
) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const input = answerInputSchema.safeParse(
    await readSiteJsonBody(request, maxBodyBytes)
  );
  if (!input.success) return siteError(400, "invalid_request");
  const { chatId } = await context.params;
  const { owner, site } = caller;
  const found = await lookupSiteChat(
    site,
    owner.scope,
    input.data.siteUser,
    chatId
  );
  if (!found.ok) return found.response;
  const { chat } = found;
  const kept = await keepSiteChatToken(
    site,
    owner.scope,
    chat,
    input.data.teemiqToken
  );
  if (!kept.ok) return kept.response;
  return oneAtATime(answersInFlight, chat.sessionId, () =>
    deliverAnswer(site, chat, input.data)
  );
}

async function deliverAnswer(site: string, chat: SiteChat, input: AnswerInput) {
  const read = await readSiteChatEvents(site, chat);
  if (!read.ok) return read.response;
  const question = openInteractions(
    foldEvents(emptySessionView(), read.events)
  ).find(
    ({ answer, interactionId, request }) =>
      interactionId === input.interactionId &&
      request.kind === "question" &&
      answer === undefined
  );
  if (!question) return siteError(409, "not_waiting");
  if (
    "optionId" in input &&
    !(question.request.options ?? []).some(({ id }) => id === input.optionId)
  ) {
    return siteError(400, "invalid_request");
  }
  const answer =
    "optionId" in input
      ? { interactionId: input.interactionId, optionId: input.optionId }
      : { interactionId: input.interactionId, text: input.text };
  const sent = await callChatEve(site, async () =>
    siteEveClient({
      ...chatGrant(site, chat),
      interaction: input.interactionId,
      op: "chat.answer",
      session: chat.sessionId,
    })
      .sessions.attach(chat.sessionId)
      .respond([answer])
  );
  if (sent.ok) return siteJson({ chatId: chat.chatId }, 202);
  // The question was answered or withdrawn meanwhile.
  return sent.response.status === 409
    ? siteError(409, "not_waiting")
    : sent.response;
}
