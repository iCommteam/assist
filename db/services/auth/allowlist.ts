import { createHash, timingSafeEqual } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
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

// The Better Auth user id (without the `better-auth:` principal prefix) of
// the member with this email, while they could sign in: on the team list,
// registered and enrolled in an authenticator. Undefined otherwise.
export async function enrolledTeamMemberId(email: string) {
  if (!isAllowedEmail(email)) return undefined;
  const [member] = await db
    .select({ id: user.id, twoFactorEnabled: user.twoFactorEnabled })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email.trim().toLowerCase()))
    .limit(1);
  return member?.twoFactorEnabled ? member.id : undefined;
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

// Whether the member with this Better Auth user id is an administrator: their
// email is on ASSIST_ADMIN_EMAILS and still on the team list.
export async function isAdminMember(userId: string) {
  const admins = env.ASSIST_ADMIN_EMAILS ?? [];
  if (admins.length === 0) return false;
  const [member] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!member) return false;
  const email = member.email.trim().toLowerCase();
  return admins.includes(email) && isAllowedEmail(email);
}
