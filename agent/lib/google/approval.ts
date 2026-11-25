import type { ApprovalContext } from "eve/tools/approval";
import { z } from "zod";
import { requireGoogleScope } from "@agent/lib/google/offer";

// A send or a new event waits for the member's Approve in the chat, in a
// session Google is offered in, and is refused outright anywhere else.
export function googleApproval(context: Pick<ApprovalContext, "session">) {
  try {
    requireGoogleScope(context);
  } catch {
    return {
      reason: "Google is not available in this conversation.",
      type: "denied",
    } as const;
  }
  return "user-approval" as const;
}

// The approval shows the member every character that goes out, so text that
// other people receive may hold nothing that shows nothing: no control
// character but a line break or a tab, and no format or other
// default-ignorable character (a zero-width space, a joiner, a bidirectional
// control, a variation selector, a tag character) but the two direction marks
// Hebrew text carries. Nor more than two blank lines in a row, which would
// push the rest of the text out of sight.
const hidden =
  /(?![\t\n\r\u200E\u200F])[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const lineBreak = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const blankRun = /\n(?:[\t ]*\r?\n){3,}/u;

const hiddenMessage =
  "Remove the characters that show nothing, such as zero-width spaces, joiners, bidirectional controls and the variation selectors some emoji carry: the member approves only what they can see.";

// Text shown whole in the approval, up to `max` characters.
export function shownText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !hidden.test(text), hiddenMessage)
    .refine(
      (text) => !blankRun.test(text),
      "Use at most two blank lines in a row."
    );
}

// One line shown whole in the approval, up to `max` characters once trimmed.
export function shownLine(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !lineBreak.test(text), "Keep this to one line.")
    .refine((text) => !hidden.test(text), hiddenMessage);
}
