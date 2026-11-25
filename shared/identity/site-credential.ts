import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { loginAlsoHostsSchema, loginOriginSchema } from "@shared/vault/schema";

// The site API (Next) calls the co-located eve server with this credential
// instead of the site's own token. It is signed with a key derived from the
// server-only BETTER_AUTH_SECRET, so neither a browser nor a site can mint one,
// and it is bound to one site, one operation and, for a read or a cancel, one
// session. A create may pin the task to one saved login, whose origin and
// the hosts its site also uses the API resolved, carry the owner's note for
// that login's account, and make it a look. An answer is bound to one
// open question of one session. A chat grant names the site's person and the
// chat as well, and covers only that chat's session.
const credentialPrefix = "assist-site.v1.";
const credentialLifetimeMs = 60_000;
const clockSkewMs = 5_000;
const keyLabel = "icommassist/site-channel-credential/v1";

export const siteLoginPinSchema = z.strictObject({
  alsoHosts: loginAlsoHostsSchema.optional(),
  id: z.string().min(1).max(200),
  origin: loginOriginSchema,
});

// A control character, half of a surrogate pair, a private-use character, a
// line or paragraph separator, or a format character: the bidirectional
// controls, U+200B and the tag characters, which spell words no one sees,
// among them. The two direction marks stay: Hebrew text carries them. TEEMIQ
// refuses all of this, and unassigned characters too, before it sends a
// note; those are left to it, since which are unassigned depends on the
// runtime's Unicode version.
const noteBreak = /[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}]|(?![\u200E\u200F])\p{Cf}/u;
// Anything shaped like an email address, as TEEMIQ reads one.
const emailAddress = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const invisible = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

// The owner's note for a pinned task's account, as the site's people saved
// it: where the account keeps its documents and which of them to save. One
// line of 1 to 300 characters once trimmed, with no email address, so no
// username rides along. Its shape alone: the site API also checks every
// address in it against the login's fence.
export const siteTaskNoteSchema = z
  .string()
  .refine((note) => !noteBreak.test(note))
  .trim()
  .min(1)
  .max(300)
  .refine((note) => !emailAddress.test(noteAsRead(note)));

// A note as it reads, which is how it is checked: a character that shows
// nothing and that a note may carry, a direction mark, a grapheme joiner, a
// variation selector or a filler, still leaves an email address or a web
// address it splits one to read. The note itself keeps them.
export function noteAsRead(note: string) {
  return note.replaceAll(invisible, "");
}

// The site's own id for the person a chat belongs to, such as a TEEMIQ user
// id. It is opaque to assist.
export const siteUserSchema = z
  .string()
  .regex(/^[\w.:@-]{1,128}$/u, "A site user id is 1 to 128 plain characters.");

const chatGrant = {
  chat: z.uuid(),
  site: z.string().min(1),
  siteUser: siteUserSchema,
};
const sessionId = z.string().min(1).max(512);

const siteGrantSchema = z.discriminatedUnion("op", [
  z.strictObject({ ...chatGrant, op: z.literal("chat.create") }),
  z.strictObject({
    ...chatGrant,
    op: z.literal("chat.message"),
    session: sessionId,
  }),
  z.strictObject({
    ...chatGrant,
    interaction: z.string().min(1).max(512),
    op: z.literal("chat.answer"),
    session: sessionId,
  }),
  z.strictObject({
    ...chatGrant,
    op: z.literal("chat.read"),
    session: sessionId,
  }),
  z.strictObject({
    ...chatGrant,
    op: z.literal("chat.cancel"),
    session: sessionId,
  }),
  z.strictObject({
    // A look lists what the pinned account holds and saves nothing; a task
    // without a kind fetches.
    kind: z.literal("look").optional(),
    login: siteLoginPinSchema.optional(),
    note: siteTaskNoteSchema.optional(),
    op: z.literal("create"),
    site: z.string().min(1),
  }),
  z.strictObject({
    op: z.literal("read"),
    session: z.string().min(1).max(512),
    site: z.string().min(1),
  }),
  z.strictObject({
    op: z.literal("cancel"),
    session: z.string().min(1).max(512),
    site: z.string().min(1),
  }),
  z.strictObject({
    interaction: z.string().min(1).max(512),
    op: z.literal("answer"),
    session: z.string().min(1).max(512),
    site: z.string().min(1),
  }),
]);
const claimsSchema = z.strictObject({
  exp: z.number().int().positive(),
  grant: siteGrantSchema,
});

export type SiteGrant = z.infer<typeof siteGrantSchema>;

export type SiteChatGrant = Extract<SiteGrant, { readonly chat: string }>;

export function isSiteChatGrant(grant: SiteGrant): grant is SiteChatGrant {
  return "chat" in grant;
}

export function isSiteCredential(value: string) {
  return value.startsWith(credentialPrefix);
}

export function mintSiteCredential(secret: string, grant: SiteGrant) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + credentialLifetimeMs, grant }),
    "utf8"
  ).toString("base64url");
  return `${credentialPrefix}${payload}.${sign(secret, payload).toString("base64url")}`;
}

// Returns the grant of a valid, unexpired credential, or undefined.
export function verifySiteCredential(secret: string, credential: string) {
  if (!isSiteCredential(credential)) return undefined;
  const [payload, signature, ...rest] = credential
    .slice(credentialPrefix.length)
    .split(".");
  if (!payload || !signature || rest.length > 0) return undefined;
  const expected = sign(secret, payload);
  const presented = Buffer.from(signature, "base64url");
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return undefined;
  }
  const claims = claimsSchema.safeParse(parseJson(payload));
  if (!claims.success) return undefined;
  const now = Date.now();
  const { exp, grant } = claims.data;
  if (exp <= now || exp > now + credentialLifetimeMs + clockSkewMs) {
    return undefined;
  }
  return grant;
}

function sign(secret: string, payload: string) {
  const key = Buffer.from(hkdfSync("sha256", secret, "", keyLabel, 32));
  return createHmac("sha256", key)
    .update(`${credentialPrefix}${payload}`)
    .digest();
}

function parseJson(payload: string) {
  try {
    return z
      .json()
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}
