import { z } from "zod";
import { siteUserSchema } from "@shared/identity/site-credential";
import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";
import { readSiteJsonBody } from "@app/api/site/_lib/request-body";
import { siteEveClient } from "@app/api/site/_lib/eve";
import {
  callChatEve,
  chatGrant,
  claimChatTurn,
  keepSiteChatToken,
  lookupSiteChat,
  teemiqTokenSchema,
} from "@app/api/site/chats/_lib/chat";
import {
  personMessage,
  resultMessage,
} from "@app/api/site/chats/[chatId]/_lib/stream";

const maxBodyBytes = 64 * 1024;
const messageInputSchema = z.object({
  // What the person has open, such as "About: OpenAI · 3 Nov · $20.00". The
  // agent reads it for this turn only; it is never stored in the chat.
  context: z.string().trim().min(1).max(2000).optional(),
  // A result is the outcome of a look or a fetch the site posts on the
  // person's behalf; the agent reads it as data, never as their words.
  kind: z.enum(["message", "result"]).default("message"),
  siteUser: siteUserSchema,
  teemiqToken: teemiqTokenSchema,
  text: z
    .string()
    .min(1)
    .max(8000)
    .refine((text) => text.trim().length > 0),
});

// Sends the chat one message, which starts a turn or steers the one under
// way. The site's token for its own tools is kept for that turn.
export async function POST(
  request: Request,
  context: RouteContext<"/api/site/chats/[chatId]/messages">
) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const input = messageInputSchema.safeParse(
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

  const turn = claimChatTurn(site, chat.siteUser);
  if (!turn.ok) {
    console.warn("[site] chat turn rate limited", { site });
    return siteError(429, "rate_limited", {
      "retry-after": String(turn.retryAfterSeconds),
    });
  }
  const kept = await keepSiteChatToken(
    site,
    owner.scope,
    chat,
    input.data.teemiqToken
  );
  if (!kept.ok) return kept.response;

  const { kind, text } = input.data;
  const sent = await callChatEve(site, async () =>
    siteEveClient({
      ...chatGrant(site, chat),
      op: "chat.message",
      session: chat.sessionId,
    })
      .sessions.attach(chat.sessionId)
      .send(kind === "result" ? resultMessage(text) : personMessage(text), {
        clientContext: input.data.context,
      })
  );
  return sent.ok ? siteJson({ chatId }, 202) : sent.response;
}
