import { resolveModeValue } from "@agent/lib/mode";
import { siteOfSession } from "@agent/lib/site-principal";
import { whatsappSessionOf } from "@agent/lib/whatsapp-access";
import { emailOfUser } from "@db/services/auth/allowlist";
import { bigqueryConfig, bigqueryMemberEmails } from "@shared/environment";

// Who reads the company's BigQuery: a member on ASSIST_BIGQUERY_EMAILS, in
// the web chat's interactive mode or in a full WhatsApp chat, and only while
// ASSIST_BIGQUERY_KEY holds a service account key. A site's task runs in the
// interactive mode too, for pages its owner never sees, so it is left out
// with site chats, scheduled runs and the narrow WhatsApp chat. The tools,
// their instructions and a full chat's fixed line all ask this, so one is
// never offered without the others. A full chat's member is the email the
// WhatsApp channel put on its principal; a web caller's is read from their
// user row on every call, and an email that cannot be read gets nothing.
export async function bigqueryAccess(
  context: Parameters<typeof resolveModeValue>[0]
) {
  const config = bigqueryConfig();
  if (!config) return undefined;
  const { current, initiator } = context.session.auth;
  if (siteOfSession(initiator)) return undefined;
  const caller = current ?? initiator;
  if (caller?.principalType !== "user") return undefined;
  const mode = resolveModeValue(context, {
    interactive: "interactive",
    "whatsapp-full": "whatsapp-full",
  });
  if (mode === null) return undefined;
  const members = bigqueryMemberEmails();
  if (members.length === 0) return undefined;
  const email =
    mode === "whatsapp-full"
      ? whatsappSessionOf(initiator)?.email
      : await webEmailOf(caller.principalId);
  if (email === undefined || !members.includes(email.trim().toLowerCase())) {
    return undefined;
  }
  return { config, mode, principalId: caller.principalId };
}

const betterAuthPrefix = "better-auth:";

async function webEmailOf(principalId: string) {
  if (!principalId.startsWith(betterAuthPrefix)) return undefined;
  try {
    return await emailOfUser(principalId.slice(betterAuthPrefix.length));
  } catch (error) {
    // A failed query's message names its values; only the name is logged.
    console.warn("[bigquery] the member's email could not be read", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
}
