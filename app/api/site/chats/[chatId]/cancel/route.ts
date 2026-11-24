import { activeTurn, emptySessionView, foldEvents } from "eve/events";
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
  lookupSiteChat,
  readSiteChatEvents,
} from "@app/api/site/chats/_lib/chat";

const maxBodyBytes = 1024;
const cancelInputSchema = z.object({ siteUser: siteUserSchema });

// Stops the chat's turn under way, if any; the stream then reports it
// cancelled. With no turn under way it changes nothing, so a repeated
// cancel answers the same.
export async function POST(
  request: Request,
  context: RouteContext<"/api/site/chats/[chatId]/cancel">
) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const input = cancelInputSchema.safeParse(
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

  const read = await readSiteChatEvents(site, chat);
  if (!read.ok) return read.response;
  const turn = activeTurn(foldEvents(emptySessionView(), read.events));
  if (turn) {
    const cancelled = await callChatEve(site, async () =>
      siteEveClient({
        ...chatGrant(site, chat),
        op: "chat.cancel",
        session: chat.sessionId,
      })
        .sessions.attach(chat.sessionId)
        .cancel({ signal: AbortSignal.timeout(20_000), turnId: turn.turnId })
    );
    // An ended session has no turn left to stop.
    if (!cancelled.ok && cancelled.response.status !== 410) {
      return cancelled.response;
    }
    console.info("[site] chat turn cancelled", { site });
  }
  return siteJson({ chatId }, 202);
}
