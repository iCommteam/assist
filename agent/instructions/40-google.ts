import { defineDynamic, defineInstructions } from "eve/instructions";
import { googleScopeOfSession } from "@agent/lib/google/offer";
import { googleAccountOf } from "@db/services/connectors/google";
import {
  googleAbilities,
  grantedGoogleAbilities,
} from "@shared/connectors/google/scopes";
import { applicationOrigin } from "@shared/environment/origin";
import connected from "./content/google/connected.md?raw";
import notConnected from "./content/google/not-connected.md?raw";

// What the agent may do with the caller's Google account, in the sessions
// that may use it (agent/lib/google/offer.ts) and nowhere else. It names the
// account's address and what Google granted, never a token.
const toolsOf = {
  "calendar-events":
    "`calendar_list_events` to read events, and `calendar_create_event` to create one",
  "calendar-free-busy": "`calendar_free_busy` to see when people are busy",
  "drive-read":
    "`drive_search` and `drive_read_file` to find and read Drive files, Docs and Sheets",
  "gmail-read": "`gmail_search` and `gmail_read_thread` to find and read mail",
  "gmail-write":
    "`gmail_create_draft` to save a draft, and `gmail_send` to send mail",
} as const;

export default defineDynamic(async (context) => {
  const scope = googleScopeOfSession(context);
  if (!scope) return null;
  let account: Awaited<ReturnType<typeof googleAccountOf>>;
  try {
    account = await googleAccountOf(scope);
  } catch {
    return null;
  }
  if (!account) {
    return defineInstructions({
      content: notConnected.replace(
        "{{workspaceUrl}}",
        new URL("/#connectors", applicationOrigin()).toString()
      ),
    });
  }
  const granted = new Set(grantedGoogleAbilities(account.scopes));
  const lines = googleAbilities.map((ability) =>
    granted.has(ability.id)
      ? `- ${ability.service}: ${toolsOf[ability.id]}.`
      : `- ${ability.service}: ${ability.label.toLowerCase()} was not granted, so that tool is missing.`
  );
  const reconnect = account.needsReconnect
    ? "\nGoogle no longer accepts this account's grant: the next Google tool call shows the member a Connect Google button in the chat, and the call continues once they have connected again.\n"
    : "";
  return defineInstructions({
    content: `${connected
      .replace("{{email}}", account.email)
      .replace("{{abilities}}", lines.join("\n"))}${reconnect}`,
  });
});
