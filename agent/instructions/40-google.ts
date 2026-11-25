import { defineDynamic, defineInstructions } from "eve/instructions";
import { googleScopeOfSession } from "@agent/lib/google/offer";
import { resolveModeValue } from "@agent/lib/mode";
import { googleAccountOf } from "@db/services/connectors/google";
import {
  googleAbilities,
  grantedGoogleAbilities,
} from "@shared/connectors/google/scopes";
import { applicationOrigin } from "@shared/environment/origin";
import connected from "./content/google/connected.md?raw";
import connectedWhatsapp from "./content/google/connected-whatsapp.md?raw";
import notConnected from "./content/google/not-connected.md?raw";
import notConnectedWhatsapp from "./content/google/not-connected-whatsapp.md?raw";

// What the agent may do with the caller's Google account, in the sessions
// that may use it (agent/lib/google/offer.ts) and nowhere else. It names the
// account's address and what Google granted, never a token. A full WhatsApp
// chat reads its own version: its approvals arrive as numbered messages, and
// it cannot show Google's sign-in, so the agent sends the Workspace page,
// bare on its own line, instead.
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

const web = {
  connected,
  notConnected,
  reconnect:
    "\nGoogle no longer accepts this account's grant: the next Google tool call shows the member a Connect Google button in the chat, and the call continues once they have connected again.\n",
  workspacePath: "/#connectors",
};

const whatsapp = {
  connected: connectedWhatsapp,
  notConnected: notConnectedWhatsapp,
  reconnect:
    "\nGoogle no longer accepts this account's grant, and WhatsApp cannot show Google's sign-in: a Google tool call would stop the chat. Call none. When the member asks for their mail, calendar or Drive, send assist's Workspace page bare on its own line, {{workspaceUrl}}, with one line saying to press Reconnect under Connectors there.\n",
  workspacePath: "/",
};

export default defineDynamic(async (context) => {
  const scope = googleScopeOfSession(context);
  if (!scope) return null;
  const text = resolveModeValue(context, { "whatsapp-full": whatsapp }) ?? web;
  const workspaceUrl = new URL(
    text.workspacePath,
    applicationOrigin()
  ).toString();
  let account: Awaited<ReturnType<typeof googleAccountOf>>;
  try {
    account = await googleAccountOf(scope);
  } catch {
    return null;
  }
  const withLink = (content: string) =>
    content.replaceAll("{{workspaceUrl}}", () => workspaceUrl);
  if (!account) {
    return defineInstructions({ content: withLink(text.notConnected) });
  }
  const granted = new Set(grantedGoogleAbilities(account.scopes));
  const lines = googleAbilities.map((ability) =>
    granted.has(ability.id)
      ? `- ${ability.service}: ${toolsOf[ability.id]}.`
      : `- ${ability.service}: ${ability.label.toLowerCase()} was not granted, so that tool is missing.`
  );
  const reconnect = account.needsReconnect ? withLink(text.reconnect) : "";
  const { email } = account;
  return defineInstructions({
    content: `${withLink(text.connected)
      .replace("{{email}}", () => email)
      .replace("{{abilities}}", () => lines.join("\n"))}${reconnect}`,
  });
});
