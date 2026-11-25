import { createHmac, hkdfSync, randomInt } from "node:crypto";
import { and, asc, count, eq, gt, lt, sql } from "drizzle-orm";
import {
  db,
  user,
  whatsappLinkCodes,
  whatsappLinkFailures,
  whatsappLinks,
} from "@db";
import { isAllowedEmail } from "@db/services/auth/allowlist";
import { getInstallationSecrets } from "@db/services/installation-secrets";

// The numbers members connect themselves: a member makes a code on the
// Workspace page and sends "link <code>" from their phone, and the WhatsApp
// channel links the number once the message passed its checks
// (agent/channels/whatsapp.ts). User ids here are Better Auth's, without the
// principal prefix. Nothing here logs a value.

// Eight characters with no 0, O, 1, I or L, read in any case, for 10 minutes.
const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const codeLength = 8;
const codeExpiry = sql`now() + interval '10 minutes'`;
// Failed attempts allowed in any hour from one number. Past 50 in all, a code
// that matches nothing gets no answer, but a live code still links.
const failuresPerNumber = 5;
const failuresInAll = 50;

function inLastHour() {
  return gt(whatsappLinkFailures.failedAt, sql`now() - interval '1 hour'`);
}

// An HMAC with a key of its own, derived from BETTER_AUTH_SECRET, so the Next
// server that makes a code and the eve server that reads it agree, and a
// copy of the table reveals no code.
async function codeHash(code: string) {
  const { betterAuthSecret } = await getInstallationSecrets();
  const key = Buffer.from(
    hkdfSync("sha256", betterAuthSecret, "", "assist whatsapp link code", 32)
  );
  return createHmac("sha256", key).update(code.toUpperCase()).digest("hex");
}

// A new code for the member, in place of any earlier one.
export async function createWhatsappLinkCode(userId: string) {
  const code = Array.from({ length: codeLength }, () =>
    codeAlphabet.charAt(randomInt(codeAlphabet.length))
  ).join("");
  const hash = await codeHash(code);
  const [row] = await db
    .insert(whatsappLinkCodes)
    .values({ codeHash: hash, expiresAt: codeExpiry, userId })
    .onConflictDoUpdate({
      set: { codeHash: hash, createdAt: sql`now()`, expiresAt: codeExpiry },
      target: whatsappLinkCodes.userId,
    })
    .returning({ expiresAt: whatsappLinkCodes.expiresAt });
  if (!row) throw new Error("The link code could not be saved.");
  return { code, expiresAt: row.expiresAt };
}

export async function cancelWhatsappLinkCode(userId: string) {
  await db
    .delete(whatsappLinkCodes)
    .where(eq(whatsappLinkCodes.userId, userId));
}

// Whether the member has a code that can still be used.
export async function whatsappLinkCodeLive(userId: string) {
  const [row] = await db
    .select({ userId: whatsappLinkCodes.userId })
    .from(whatsappLinkCodes)
    .where(
      and(
        eq(whatsappLinkCodes.userId, userId),
        gt(whatsappLinkCodes.expiresAt, sql`now()`)
      )
    )
    .limit(1);
  return row !== undefined;
}

// Whether this number is over its limit on failed attempts, read before any
// work is done for its message. linkWhatsappNumber checks it again.
export async function whatsappLinkLimited(phone: string) {
  const [fromNumber] = await db
    .select({ value: count() })
    .from(whatsappLinkFailures)
    .where(and(eq(whatsappLinkFailures.phone, phone), inLastHour()));
  return (fromNumber?.value ?? 0) >= failuresPerNumber;
}

// One "link <code>" message that passed Twilio's record check, decided in one
// transaction: within the number's limit on failed attempts, a live code, a
// member who may use WhatsApp, and a number that is free. A code that is
// found is used up, whatever follows. A member who had linked another number
// gets this one in its place. Every refusal counts against the limits, and is
// committed with the transaction; lastTry says it was the number's last
// attempt for the hour.
export async function linkWhatsappNumber(attempt: {
  readonly code: string;
  // The sender's entry on ASSIST_WHATSAPP_NUMBERS, when it has one.
  readonly listing: { readonly email: string | undefined } | undefined;
  readonly phone: string;
  readonly sid: string;
}) {
  const hash = await codeHash(attempt.code);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('whatsapp-link'))`
    );
    await tx
      .delete(whatsappLinkFailures)
      .where(lt(whatsappLinkFailures.failedAt, sql`now() - interval '1 day'`));
    await tx
      .delete(whatsappLinkCodes)
      .where(lt(whatsappLinkCodes.expiresAt, sql`now()`));
    const [fromNumber] = await tx
      .select({ value: count() })
      .from(whatsappLinkFailures)
      .where(and(eq(whatsappLinkFailures.phone, attempt.phone), inLastHour()));
    const failures = fromNumber?.value ?? 0;
    if (failures >= failuresPerNumber) return { outcome: "limited" as const };
    const recordFailure = async () => {
      await tx
        .insert(whatsappLinkFailures)
        .values({ phone: attempt.phone, sid: attempt.sid })
        .onConflictDoNothing();
    };
    const refuse = async (outcome: "failed" | "server" | "taken") => {
      await recordFailure();
      return { lastTry: failures + 1 >= failuresPerNumber, outcome };
    };
    const [code] = await tx
      .delete(whatsappLinkCodes)
      .where(
        and(
          eq(whatsappLinkCodes.codeHash, hash),
          gt(whatsappLinkCodes.expiresAt, sql`now()`)
        )
      )
      .returning({ userId: whatsappLinkCodes.userId });
    if (!code) {
      const [inAll] = await tx
        .select({ value: count() })
        .from(whatsappLinkFailures)
        .where(inLastHour());
      if ((inAll?.value ?? 0) < failuresInAll) return refuse("failed");
      // Counted against the number all the same, so its own limit holds
      // while nobody is answered.
      await recordFailure();
      return { outcome: "limited" as const };
    }
    const [member] = await tx
      .select({ email: user.email, twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, code.userId))
      .limit(1);
    const email = member?.email.trim().toLowerCase() ?? "";
    if (!member?.twoFactorEnabled || !isAllowedEmail(email)) {
      return refuse("failed");
    }
    if (attempt.listing) {
      return attempt.listing.email === email
        ? { email, outcome: "already" as const }
        : refuse("server");
    }
    const [current] = await tx
      .select({ userId: whatsappLinks.userId })
      .from(whatsappLinks)
      .where(eq(whatsappLinks.phone, attempt.phone))
      .limit(1);
    if (current) {
      return current.userId === code.userId
        ? { email, outcome: "already" as const }
        : refuse("taken");
    }
    const [previous] = await tx
      .delete(whatsappLinks)
      .where(eq(whatsappLinks.userId, code.userId))
      .returning({ phone: whatsappLinks.phone });
    await tx.insert(whatsappLinks).values({
      messageSid: attempt.sid,
      phone: attempt.phone,
      userId: code.userId,
    });
    return {
      email,
      outcome: "linked" as const,
      previousPhone: previous?.phone,
      userId: code.userId,
    };
  });
}

const linkColumns = {
  id: whatsappLinks.id,
  linkedAt: whatsappLinks.linkedAt,
  phone: whatsappLinks.phone,
  userId: whatsappLinks.userId,
};

// The number this member linked, if any.
export async function whatsappLinkOf(userId: string) {
  const [row] = await db
    .select(linkColumns)
    .from(whatsappLinks)
    .where(eq(whatsappLinks.userId, userId))
    .limit(1);
  return row;
}

// The member a linked number reaches, with their email as stored.
export async function linkedWhatsappMemberOf(phone: string) {
  const [row] = await db
    .select({
      email: user.email,
      id: whatsappLinks.id,
      userId: whatsappLinks.userId,
    })
    .from(whatsappLinks)
    .innerJoin(user, eq(user.id, whatsappLinks.userId))
    .where(eq(whatsappLinks.phone, phone))
    .limit(1);
  return row;
}

// The number the member with this email linked, if any.
export async function linkedWhatsappNumberOf(email: string) {
  const [row] = await db
    .select(linkColumns)
    .from(whatsappLinks)
    .innerJoin(user, eq(user.id, whatsappLinks.userId))
    .where(eq(sql`lower(${user.email})`, email.trim().toLowerCase()))
    .limit(1);
  return row;
}

// Every linked number with its member's email, oldest first.
export async function allWhatsappLinks() {
  return db
    .select({ ...linkColumns, email: user.email })
    .from(whatsappLinks)
    .innerJoin(user, eq(user.id, whatsappLinks.userId))
    .orderBy(asc(whatsappLinks.linkedAt));
}

export async function whatsappLinkById(id: string) {
  const [row] = await db
    .select(linkColumns)
    .from(whatsappLinks)
    .where(eq(whatsappLinks.id, id))
    .limit(1);
  return row;
}

// Deletes the link while it is still this member's, and says which number
// it was.
export async function deleteWhatsappLink(id: string, userId: string) {
  const [row] = await db
    .delete(whatsappLinks)
    .where(and(eq(whatsappLinks.id, id), eq(whatsappLinks.userId, userId)))
    .returning({ phone: whatsappLinks.phone });
  return row;
}
