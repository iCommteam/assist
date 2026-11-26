import { defineState } from "eve/context";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { whatsappApprovalStatus } from "@agent/lib/approval-response";
import { unseenPartOf } from "@agent/lib/google/shown-text";

// Once a Google tool has run in a session, the member's mail, events or files
// may be in its context, and text in them may try to carry that on through
// the browser, which opens any site and asks no one. From then on each
// browser task in the session waits for the member's approval, which shows
// the whole assignment. A session that never used Google keeps its browser
// as it was. The mark lasts the session, through compactions and clears.
const googleUsed = defineState<boolean>("assist.google.used", () => false);

// An assignment the member approves is shown whole, so it is held to what an
// approval shows: at most 4,000 characters, all of them visible.
const maxApprovedAssignment = 4000;

// withGoogle (agent/lib/google/client.ts) marks the session before every
// Google call.
export function markGoogleUsed() {
  googleUsed.update(() => true);
}

// run_browser's approval policy, given the call's assignment. A session
// whose mark cannot be read asks. An assignment the member could not see
// whole is refused, with a reason the model reads, and on WhatsApp so is one
// whose approval cannot be drawn.
export function browserApproval(
  context: Pick<ApprovalContext, "session">,
  message: string | undefined
): ApprovalStatus {
  let used: boolean;
  try {
    used = googleUsed.get();
  } catch {
    used = true;
  }
  if (!used) return "not-applicable";
  if (message === undefined) return "user-approval";
  const unseen =
    message.length > maxApprovedAssignment
      ? "Keep a browser task's assignment to at most 4,000 characters, since the member approves it whole: split longer work into several tasks."
      : unseenPartOf(message);
  if (unseen !== undefined) {
    return { reason: `Nothing ran. ${unseen}`, type: "denied" };
  }
  return whatsappApprovalStatus(
    context,
    browserPrompt(message),
    "Split the work into shorter browser tasks."
  );
}

// The assignment is shown whole and last, so nothing in it can pass for the
// question.
export function browserPrompt(message: string) {
  return [
    "Start this browser task? This chat has used your Google account, so each browser task waits for you. The browser follows this assignment and may open any site it names:",
    "",
    message,
  ].join("\n");
}
