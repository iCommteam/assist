import type { DynamicContext } from "eve";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { siteKindOfSession } from "@agent/lib/site-principal";
import { googleOAuthClient } from "@shared/connectors/google/oauth";

// The modes in which a member's connected Google account is offered:
// assist's own web chat, and a full WhatsApp chat, whose approvals the member
// answers with a numbered reply (agent/channels/whatsapp.ts). A site chat,
// WhatsApp's narrow mode, a locked member's, and scheduled runs never get it,
// because they are not listed.
export const googleModes = ["interactive", "whatsapp-full"] as const;

const offeredByMode = Object.fromEntries(
  googleModes.map((mode) => [mode, true] as const)
);

interface GoogleSessionContext {
  readonly session: Pick<DynamicContext["session"], "auth">;
}

// The workspace whose Google account this session may use, or undefined when
// it may use none: Google is not set up, the mode is not listed, the session
// was started by a connected site, or no signed-in member is calling. A site
// task runs in the interactive mode as the site's owner, so its initiator is
// checked on its own: a site never reaches the owner's Google account. A full
// WhatsApp chat reaches only its own member's account, whether the turn came
// from their WhatsApp or from the chat's page in the web app.
export function googleScopeOfSession(context: GoogleSessionContext) {
  if (!googleOAuthClient()) return undefined;
  const { current, initiator } = context.session.auth;
  if (siteKindOfSession(initiator) !== undefined) return undefined;
  if (resolveModeValue(context, offeredByMode) !== true) return undefined;
  if (current?.principalType !== "user") return undefined;
  if (
    initiator?.authenticator === "assist-whatsapp" &&
    initiator.principalId !== current.principalId
  ) {
    return undefined;
  }
  try {
    return scopeFromPrincipal(current);
  } catch {
    return undefined;
  }
}

// For a tool's executor and approval policy: the same decision, as an error
// the model reads, for a call that reached a tool this session was never
// meant to have.
export function requireGoogleScope(context: GoogleSessionContext) {
  const scope = googleScopeOfSession(context);
  if (!scope) {
    throw new Error("Google is not available in this conversation.");
  }
  return scope;
}
