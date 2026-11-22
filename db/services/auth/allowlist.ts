import { createHash, timingSafeEqual } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db, user } from "@db";
import { env } from "@shared/environment";

// The env lists are already trimmed and lower-cased, so matching is
// case-insensitive. An unset list admits nobody.
export function isAllowedEmail(email: string) {
  return (env.ASSIST_ALLOWED_EMAILS ?? []).includes(email.trim().toLowerCase());
}

// Hashing both sides gives equal-length buffers, so timingSafeEqual also hides
// the configured code's length. An unset code matches nothing.
export function signupCodeMatches(code: string) {
  const expected = env.ASSIST_SIGNUP_CODE?.trim();
  if (!expected) return false;
  return timingSafeEqual(digest(code.trim()), digest(expected));
}

// Better Auth user ids (without the `better-auth:` principal prefix) whose
// email is on the team list.
export async function allowedUserIds() {
  const emails = env.ASSIST_ALLOWED_EMAILS ?? [];
  if (emails.length === 0) return [];
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(inArray(sql`lower(${user.email})`, emails));
  return rows.map(({ id }) => id);
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}
