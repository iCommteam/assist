import { z } from "zod";

// The approval shows the member every character that goes out, so text that
// other people receive, or a browser task's assignment, may hold nothing that
// shows nothing: no control character but a line break or a tab, and no
// format or other default-ignorable character (a zero-width space, a joiner,
// a bidirectional control, a variation selector, a tag character) but the two
// direction marks Hebrew text carries. Nor more than two blank lines in a
// row, which would push the rest of the text out of sight. This file imports
// nothing else, so run_browser's approval can read it.
const hidden =
  /(?![\t\n\r\u200E\u200F])[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const lineBreak = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const blankRun = /\n(?:[\t ]*\r?\n){3,}/u;

const hiddenMessage =
  "Remove the characters that show nothing, such as zero-width spaces, joiners, bidirectional controls and the variation selectors some emoji carry: the member approves only what they can see.";
const blankRunMessage = "Use at most two blank lines in a row.";

// What would keep part of the text out of the member's sight, or undefined.
export function unseenPartOf(text: string) {
  if (hidden.test(text)) return hiddenMessage;
  if (blankRun.test(text)) return blankRunMessage;
  return undefined;
}

// Text shown whole in the approval, up to `max` characters.
export function shownText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !hidden.test(text), hiddenMessage)
    .refine((text) => !blankRun.test(text), blankRunMessage);
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
