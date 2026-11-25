import type { SessionAuthContext } from "eve/context";
import type {
  ApprovalResponseContext,
  ApprovalResponseDecision,
} from "eve/tools/approval";

// The attribute the WhatsApp channel adds to the member's principal when it
// answers a reply of exactly 1 (agent/channels/whatsapp.ts): the id of the
// approval that reply answers.
export const whatsappApprovalAttribute = "whatsappApproval";

// Who may answer a tool's approval. Only the person whose turn asked, as
// eve's own default allows; this policy replaces that default, so it says so
// itself. On WhatsApp, eve would also read a typed "1", "approve", "01" or
// "1.0" as an approve, even one the member sent before the approval was
// shown, so there an approve counts only when the channel itself gave it,
// naming this approval. A decline from the asker always counts.
export function approvalResponse<TInput>({
  request,
  response,
}: Pick<
  ApprovalResponseContext<TInput>,
  "request" | "response"
>): ApprovalResponseDecision {
  const asker = request.principal;
  const responder = response.principal;
  if (asker === null || !samePrincipal(asker, responder)) {
    return {
      reason: "Only the person who asked for this can answer it.",
      status: "rejected",
    };
  }
  if (
    response.decision === "approve" &&
    responder.authenticator === "assist-whatsapp" &&
    responder.attributes[whatsappApprovalAttribute] !== request.interactionId
  ) {
    return {
      reason:
        "On WhatsApp, only a reply of 1 to the approval's message approves it.",
      status: "rejected",
    };
  }
  return { status: "allowed" };
}

function samePrincipal(a: SessionAuthContext, b: SessionAuthContext) {
  return (
    a.authenticator === b.authenticator &&
    (a.issuer ?? "") === (b.issuer ?? "") &&
    a.principalType === b.principalType &&
    a.principalId === b.principalId
  );
}
