import { z } from "zod";
import { siteUserSchema } from "@shared/identity/site-credential";
import {
  authenticateSiteRequest,
  siteError,
  siteNoContent,
} from "@app/api/site/_lib/site-auth";
import { readSiteJsonBody } from "@app/api/site/_lib/request-body";
import {
  keepSiteChatToken,
  lookupSiteChat,
  teemiqTokenSchema,
} from "@app/api/site/chats/_lib/chat";

const maxBodyBytes = 8 * 1024;
const tokenInputSchema = z.object({
  siteUser: siteUserSchema,
  teemiqToken: teemiqTokenSchema,
});

// Replaces the chat's token while a turn runs, so the agent's tools outlast a
// token's own lifetime. The end of the turn clears it.
export async function POST(
  request: Request,
  context: RouteContext<"/api/site/chats/[chatId]/token">
) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const input = tokenInputSchema.safeParse(
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
  const kept = await keepSiteChatToken(
    site,
    owner.scope,
    found.chat,
    input.data.teemiqToken
  );
  return kept.ok ? siteNoContent() : kept.response;
}
