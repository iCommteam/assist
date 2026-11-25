import { z } from "zod";
import { env, whatsappNumbersVariable } from "@shared/environment";

// ASSIST_WHATSAPP_NUMBERS maps each member's number to their assist email:
// "+15551234567=member@example.com,...". It is the operator's override of the
// numbers members connect themselves (db/services/whatsapp-numbers.ts), read
// on every message, reply, turn and model call, and on every view of the
// Workspace page. An entry that does not parse is skipped, and a number
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

// Whether the list names this number at all, and the assist email it reaches:
// none for a number listed for two emails. Undefined for a number the list
// does not name.
export function whatsappListingOf(number: string) {
  const emails = new Set(
    listedNumbers()
      .filter(([listed]) => listed === number)
      .map(([, email]) => email)
  );
  if (emails.size === 0) return undefined;
  if (emails.size > 1) {
    reportOnce(
      "ASSIST_WHATSAPP_NUMBERS lists a number for two emails; it reaches nobody."
    );
    return { email: undefined };
  }
  return { email: [...emails][0] };
}

// Every listed number that reaches someone, once, with that email.
export function listedWhatsappMembers() {
  const members = new Map<string, string>();
  for (const [number] of listedNumbers()) {
    const email = whatsappListingOf(number)?.email;
    if (email !== undefined) members.set(number, email);
  }
  return [...members].map(([number, email]) => ({ email, number }));
}

// The listed numbers that reach this email.
export function numbersOfMember(email: string) {
  const normalized = email.trim().toLowerCase();
  return listedWhatsappMembers()
    .filter((member) => member.email === normalized)
    .map(({ number }) => number);
}

// Whether the WhatsApp channel is open: without all three Twilio variables,
// every webhook is refused.
export function whatsappChannelConfigured() {
  return (
    env.TWILIO_ACCOUNT_SID !== undefined &&
    env.TWILIO_AUTH_TOKEN !== undefined &&
    env.TWILIO_WHATSAPP_FROM !== undefined
  );
}

const reportedProblems = new Set<string>();

function reportOnce(problem: string) {
  if (reportedProblems.has(problem)) return;
  reportedProblems.add(problem);
  console.warn(`[whatsapp] ${problem}`);
}
