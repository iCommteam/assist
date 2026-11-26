import type { ApprovalContext } from "eve/tools/approval";
import { whatsappApprovalStatus } from "@agent/lib/approval-response";
import { requireGoogleScope } from "@agent/lib/google/offer";

// A send or a new event waits for the member's Approve in the chat, in a
// session Google is offered in, and is refused outright anywhere else. On
// WhatsApp it is asked only when its approval fits in one message there;
// `shown` is that approval and how to make it fit, from the call's input.
export function googleApproval(
  context: Pick<ApprovalContext, "session">,
  shown: { readonly prompt: string; readonly shorter: string } | undefined
) {
  try {
    requireGoogleScope(context);
  } catch {
    return {
      reason: "Google is not available in this conversation.",
      type: "denied",
    } as const;
  }
  return shown === undefined
    ? ("user-approval" as const)
    : whatsappApprovalStatus(context, shown.prompt, shown.shorter);
}
