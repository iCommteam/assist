import { defineState } from "eve/context";

// Once a Google tool has run in a session, the member's mail, events or files
// may be in its context, and text in them may try to carry that on through
// the browser, which opens any site and asks no one. From then on each
// browser task in the session waits for the member's approval, which shows
// the whole assignment. A session that never used Google keeps its browser
// as it was. The mark lasts the session, through compactions and clears.
const googleUsed = defineState<boolean>("assist.google.used", () => false);

// withGoogle (agent/lib/google/client.ts) marks the session before every
// Google call.
export function markGoogleUsed() {
  googleUsed.update(() => true);
}

// run_browser's approval policy. A session whose mark cannot be read asks.
export function browserApproval() {
  try {
    return googleUsed.get() ? "user-approval" : "not-applicable";
  } catch {
    return "user-approval";
  }
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
