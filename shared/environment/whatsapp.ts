import { z } from "zod";
import { whatsappNumbersVariable } from "@shared/environment";

// ASSIST_WHATSAPP_NUMBERS maps each member's number to their assist email:
// "+15551234567=member@example.com,...". The WhatsApp channel and its hooks
// read it on every message, reply, turn and model call, and the Workspace
// page on every view. An entry that does not parse is skipped, and a number
// listed for two emails reaches nobody; each problem is logged once, values
// never.
const numberEntrySchema = z
  .string()
  .transform((entry) => entry.split("="))
  .pipe(
    z.tuple([
      z
        .string()
        .trim()
        .regex(/^\+[1-9]\d{6,14}$/u),
      z.string().trim().toLowerCase().pipe(z.email()),
    ])
  );

function listedNumbers() {
  const entries: (readonly [number: string, email: string])[] = [];
  for (const entry of whatsappNumbersVariable().split(",")) {
    if (entry.trim() === "") continue;
    const parsed = numberEntrySchema.safeParse(entry);
    if (!parsed.success) {
      reportOnce(
        "An ASSIST_WHATSAPP_NUMBERS entry is not +<number>=<email>; it is skipped."
      );
      continue;
    }
    entries.push(parsed.data);
  }
  return entries;
}

// The assist email a number is listed for, or undefined.
export function memberEmailOf(number: string) {
  const emails = new Set(
    listedNumbers()
      .filter(([listed]) => listed === number)
      .map(([, email]) => email)
  );
  if (emails.size > 1) {
    reportOnce(
      "ASSIST_WHATSAPP_NUMBERS lists a number for two emails; it reaches nobody."
    );
    return undefined;
  }
  return [...emails][0];
}

// The numbers that reach this email.
export function numbersOfMember(email: string) {
  const normalized = email.trim().toLowerCase();
  return listedNumbers()
    .filter(
      ([number, listed]) =>
        listed === normalized && memberEmailOf(number) === normalized
    )
    .map(([number]) => number);
}

const reportedProblems = new Set<string>();

function reportOnce(problem: string) {
  if (reportedProblems.has(problem)) return;
  reportedProblems.add(problem);
  console.warn(`[whatsapp] ${problem}`);
}
