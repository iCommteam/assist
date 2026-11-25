import { defineDynamic, defineInstructions } from "eve/instructions";
import { resolveModeValue } from "@agent/lib/mode";
import { applicationOrigin } from "@shared/environment/origin";
import interactiveInstructions from "./content/role/interactive.md?raw";
import scheduledReportInstructions from "./content/role/scheduled-report.md?raw";
import scheduledWorkerInstructions from "./content/role/scheduled-worker.md?raw";
import siteChatInstructions from "./content/role/site-chat.md?raw";
import whatsappFullInstructions from "./content/role/whatsapp-full.md?raw";
import whatsappInstructions from "./content/role/whatsapp.md?raw";

// The web chat's role and a full WhatsApp chat's name the vault page, from
// the configured origin; the origin is read only for a role that names it.
export default defineDynamic((context) => {
  const content = resolveModeValue(context, {
    interactive: interactiveInstructions,
    "scheduled-report": scheduledReportInstructions,
    "scheduled-worker": scheduledWorkerInstructions,
    "site-chat": siteChatInstructions,
    whatsapp: whatsappInstructions,
    "whatsapp-full": whatsappFullInstructions,
  });
  if (content === null) return null;
  return defineInstructions({
    content: content.replaceAll("{{vaultPage}}", () =>
      new URL("/vault", applicationOrigin()).toString()
    ),
  });
});
