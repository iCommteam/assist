import type { SessionAuthContext } from "eve/context";
import type {
  ApprovalContext,
  ApprovalResponseContext,
  ApprovalResponseDecision,
  ApprovalStatus,
} from "eve/tools/approval";

// The WhatsApp channel's principal (agent/channels/whatsapp.ts). This file
// stays free of the channel's imports, which the workflow bundle of
// run_browser cannot load.
const whatsappAuthenticator = "assist-whatsapp";

// The attribute the WhatsApp channel adds to the member's principal when it
// answers a reply of exactly 1 (agent/channels/whatsapp.ts): the id of the
// approval that reply answers.
export const whatsappApprovalAttribute = "whatsappApproval";

// A full WhatsApp chat draws an approval as one message: its whole prompt,
// then this line, within Twilio's 1,600 characters. In two messages, text the
// model wrote, which ends every prompt, could fill the last one with a
// look-alike of another step while the real recipients sat in the first; so
// an approval that does not fit is never drawn, and neither is one whose text
// asks for a reply of 1, which would read as the approval's own end.
const whatsappReplyLine = "Reply 1 to approve or 2 to decline.";
const whatsappMessageLimit = 1600;
const replyOfOne = /\breply\s+(?:with\s+)?1(?!\d)/iu;

// The one WhatsApp message an approval is drawn as, or undefined when it
// cannot be.
export function whatsappApprovalMessage(prompt: string) {
  const message = `${prompt.trim()}\n\n${whatsappReplyLine}`;
  return message.length <= whatsappMessageLimit && !replyOfOne.test(prompt)
    ? message
    : undefined;
}

// A tool's request policy for a call whose approval shows `prompt`. A turn
// sent from WhatsApp is asked only when its approval can be drawn there;
// otherwise the call is refused with a reason the model reads, `shorter`
// saying how to make it fit. A turn typed on the web, in a WhatsApp chat's
// own page too, shows its approval there, whole.
export function whatsappApprovalStatus(
  { session }: Pick<ApprovalContext, "session">,
  prompt: string,
  shorter: string
): ApprovalStatus {
  if (session.auth.current?.authenticator !== whatsappAuthenticator) {
    return "user-approval";
  }
  if (replyOfOne.test(prompt)) {
    return {
      reason: `Nothing ran. On WhatsApp the approval itself ends with "${whatsappReplyLine}", so what it shows may not ask for a reply of 1. Take that out and call again.`,
      type: "denied",
    };
  }
  const over =
    `${prompt.trim()}\n\n${whatsappReplyLine}`.length - whatsappMessageLimit;
  if (over <= 0) return "user-approval";
  return {
    reason: `Nothing ran. On WhatsApp an approval must fit in one message of 1,600 characters, and this one is ${String(over)} characters over. ${shorter}`,
    type: "denied",
  };
}

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
    responder.authenticator === whatsappAuthenticator &&
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
