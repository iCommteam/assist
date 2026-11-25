import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import executionSafety from "./content/execution-safety.md?raw";

// A full WhatsApp chat has no schedules, and its approvals arrive as numbered
// messages (agent/channels/whatsapp.ts), so it reads its own approval line.
const scheduleApproval =
  "except creating or changing a schedule, which the user approves in an approval card.";
const whatsappApproval =
  "except a step whose approval reaches the member on WhatsApp as its own message, such as a Gmail send, which they answer there.";

export default defineDynamic((context) =>
  resolveModeInstructions(context, {
    interactive: executionSafety,
    "scheduled-worker": executionSafety,
    "whatsapp-full": executionSafety.replace(
      scheduleApproval,
      whatsappApproval
    ),
  })
);
