import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { loginOriginSchema } from "@shared/vault/schema";

// The site API (Next) calls the co-located eve server with this credential
// instead of the site's own token. It is signed with a key derived from the
// server-only BETTER_AUTH_SECRET, so neither a browser nor a site can mint one,
// and it is bound to one site, one operation and, for a read, one session. A
// create may pin the task to one saved login, whose origin the API resolved.
// An answer is bound to one open question of one session.
const credentialPrefix = "assist-site.v1.";
const credentialLifetimeMs = 60_000;
const clockSkewMs = 5_000;
const keyLabel = "icommassist/site-channel-credential/v1";

export const siteLoginPinSchema = z.strictObject({
  id: z.string().min(1).max(200),
  origin: loginOriginSchema,
});

const siteGrantSchema = z.discriminatedUnion("op", [
  z.strictObject({
    login: siteLoginPinSchema.optional(),
    op: z.literal("create"),
    site: z.string().min(1),
  }),
  z.strictObject({
    op: z.literal("read"),
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
