import { defineDynamic, defineInstructions } from "eve/instructions";
import { whatsappSessionOf } from "@agent/lib/whatsapp-access";
import { applicationOrigin } from "@shared/environment/origin";

// One short block for a full WhatsApp chat's turn: where this turn's message
// came from, read from the turn's own sender, and the chat's link in assist's
// web app, which the agent sends for a one-time code or anything else that
// needs a screen.
export default defineDynamic((context) => {
  const member = whatsappSessionOf(context.session.auth.initiator);
  if (member?.level !== "full") return null;
  const fromWhatsapp =
    whatsappSessionOf(context.session.auth.current)?.level === "full";
  const webChat = new URL(
    `/chat/${encodeURIComponent(context.session.id)}`,
    applicationOrigin()
  ).toString();
  return defineInstructions({
    content: [
      "# This turn",
      "",
      fromWhatsapp
        ? "- This turn's message came from the member's WhatsApp."
        : "- This turn's message came from assist's web app, where the member opened this WhatsApp chat. Your replies still go to their WhatsApp.",
      `- This chat in assist's web app: ${webChat}`,
      "",
    ].join("\n"),
  });
});
