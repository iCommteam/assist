import { resolveModeValue } from "@agent/lib/mode";
import { siteOfSession } from "@agent/lib/site-principal";
import { bigqueryConfig } from "@shared/environment";

// Who reads the company's BigQuery: a member in the web chat's interactive
// mode or in a full WhatsApp chat, and only while ASSIST_BIGQUERY_KEY holds a
// service account key. A site's task runs in the interactive mode too, for
// pages its owner never sees, so it is left out with site chats, scheduled
// runs and the narrow WhatsApp chat. The tools and their instructions both
// ask this, so one is never offered without the other.
export function bigqueryAccess(
  context: Parameters<typeof resolveModeValue>[0]
) {
  const config = bigqueryConfig();
  if (!config) return undefined;
  if (siteOfSession(context.session.auth.initiator)) return undefined;
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") return undefined;
  const mode = resolveModeValue(context, {
    interactive: "interactive",
    "whatsapp-full": "whatsapp-full",
  });
  if (mode === null) return undefined;
  return { config, mode, principalId: caller.principalId };
}
