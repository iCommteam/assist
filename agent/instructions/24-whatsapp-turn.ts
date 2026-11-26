import { defineDynamic, defineInstructions } from "eve/instructions";
import { whatsappSessionOf } from "@agent/lib/whatsapp-access";
import { applicationOrigin } from "@shared/environment/origin";

// One short block for a full WhatsApp chat's turn: where this turn's message
// came from, read from the turn's own sender, and so where its approvals
// show (agent/channels/whatsapp.ts); the chat's link in assist's web
// app, which the agent sends for a one-time code; and the link to a new web
// chat, for a schedule. The chat's own page keeps the chat's mode, which has
// no schedules, so only a new chat can set one up.
export default defineDynamic((context) => {
  const member = whatsappSessionOf(context.session.auth.initiator);
  if (member?.level !== "full") return null;
  const fromWhatsapp =
    whatsappSessionOf(context.session.auth.current)?.level === "full";
  const webChat = new URL(
    `/chat/${encodeURIComponent(context.session.id)}`,
    applicationOrigin()
  ).toString();
  const newWebChat = new URL("/chat", applicationOrigin()).toString();
  return defineInstructions({
    content: [
      "# This turn",
      "",
      ...(fromWhatsapp
        ? ["- This turn's message came from the member's WhatsApp."]
        : [
            "- This turn's message came from assist's web app, where the member opened this WhatsApp chat. Your replies still go to their WhatsApp.",
            "- This turn's approvals show on this chat's page in assist's web app, not on WhatsApp: tell the member to answer them there.",
          ]),
      `- This chat in assist's web app: ${webChat}`,
      `- A new chat in assist's web app: ${newWebChat}`,
      "",
    ].join("\n"),
  });
});
