import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import { googleRequestedScopes } from "./scopes";

// Google's OAuth endpoints for a Web application client
// (developers.google.com/identity/protocols/oauth2/web-server).
const authorizeEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const revokeEndpoint = "https://oauth2.googleapis.com/revoke";

// The one redirect URI registered on the OAuth client. Google matches it
// exactly, so it never carries anything per flow: the state names the flow.
export const googleCallbackPath = "/api/connectors/google/callback";

// eve's callback for one sign-in attempt in a chat
// (/eve/v1/connections/:name/callback/:attemptId/:token). It changes with
// every attempt, so Google never sees it: the registered callback forwards
// the browser to its path, on assist's own origin, once the tokens are kept.
// Its origin is never used, because outside Vercel eve mints it from the
// server's own address.
const eveCallbackPathPattern =
  /^\/eve\/v1\/connections\/[^/?#]+\/callback\/[^/?#]+\/[^/?#]+$/u;

export function isEveCallbackPath(path: string) {
  // A path the browser would rewrite, such as one with a dot segment or a
  // backslash, could land elsewhere, so it must already be normal.
  return (
    eveCallbackPathPattern.test(path) &&
    new URL(path, "https://assist.invalid").pathname === path
  );
}

const requestTimeoutMs = 10_000;

// The OAuth client every member connects through, or undefined until an
// administrator sets both variables; then there are no Google tools at all.
export function googleOAuthClient() {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

type GoogleOAuthClient = NonNullable<ReturnType<typeof googleOAuthClient>>;

function googleRedirectUri() {
  return new URL(googleCallbackPath, applicationOrigin()).toString();
}

// A fresh state and PKCE pair for one connect. The verifier never leaves the
// server; Google sees only its S256 challenge.
export function newGoogleFlow() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
    verifier,
  };
}

export function googleAuthorizeUrl(
  client: GoogleOAuthClient,
  flow: { readonly challenge: string; readonly state: string },
  loginHint: string | undefined
) {
  const params = new URLSearchParams({
    // A refresh token on every consent, including a reconnect.
    access_type: "offline",
    client_id: client.clientId,
    code_challenge: flow.challenge,
    code_challenge_method: "S256",
    include_granted_scopes: "true",
    prompt: "consent",
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: googleRequestedScopes.join(" "),
    state: flow.state,
  });
  // Google preselects the member's own company account.
  if (loginHint) params.set("login_hint", loginHint);
  const url = new URL(authorizeEndpoint);
  url.search = params.toString();
  return url.toString();
}

// Google refused the grant: revoked, expired, or the code was already used.
// Only connecting again helps.
export class GoogleGrantError extends Error {
  constructor() {
    super("Google no longer accepts this account's grant.");
    this.name = "GoogleGrantError";
  }
}

// Google did not answer, or answered something unexpected. The grant may
// still be good, so nothing is dropped.
export class GoogleUnavailableError extends Error {
  constructor(status: number | undefined) {
    super(
      status === undefined
        ? "Google could not be reached."
        : `Google answered ${String(status)}.`
    );
    this.name = "GoogleUnavailableError";
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  id_token: z.string().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

const tokenErrorSchema = z.object({ error: z.string() });

// The ID token comes straight from Google's token endpoint over TLS, in
// exchange for this client's secret, so its claims are read without checking
// the signature, as Google's OpenID Connect guide allows.
const identityClaimsSchema = z.object({
  email: z.string().min(1),
  sub: z.string().min(1),
});

export async function exchangeGoogleCode(
  client: GoogleOAuthClient,
  code: string,
  verifier: string
) {
  const token = await postToken({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: googleRedirectUri(),
  });
  if (!token.refresh_token || !token.id_token) {
    throw new GoogleUnavailableError(undefined);
  }
  const claims = identityClaimsSchema.safeParse(
    decodeJwtPayload(token.id_token)
  );
  if (!claims.success) throw new GoogleUnavailableError(undefined);
  return {
    accessToken: token.access_token,
    accessTokenExpiresAt: expiresAt(token.expires_in),
    email: claims.data.email,
    refreshToken: token.refresh_token,
    scopes: grantedScopes(token.scope),
    subject: claims.data.sub,
  };
}

export async function refreshGoogleToken(
  client: GoogleOAuthClient,
  refreshToken: string
) {
  const token = await postToken({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return {
    accessToken: token.access_token,
    accessTokenExpiresAt: expiresAt(token.expires_in),
    refreshToken: token.refresh_token,
    scopes: token.scope === undefined ? undefined : grantedScopes(token.scope),
  };
}

// Revoking the refresh token ends the whole grant, its access tokens
// included. True when Google confirmed it, or answered that the token was
// already invalid.
export async function revokeGoogleToken(token: string) {
  try {
    const response = await fetch(revokeEndpoint, {
      body: new URLSearchParams({ token }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.ok) return true;
    if (response.status !== 400) return false;
    const body = tokenErrorSchema.safeParse(await readJson(response));
    return body.success && body.data.error === "invalid_token";
  } catch {
    return false;
  }
}

// Errors name the status and Google's error code only: the request body,
// which carries the client secret and the code or refresh token, never
// reaches a message.
async function postToken(form: Readonly<Record<string, string>>) {
  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      body: new URLSearchParams(form),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    throw new GoogleUnavailableError(undefined);
  }
  const body = await readJson(response);
  if (response.ok) {
    const token = tokenResponseSchema.safeParse(body);
    if (token.success) return token.data;
    throw new GoogleUnavailableError(response.status);
  }
  const failure = tokenErrorSchema.safeParse(body);
  if (response.status === 400 && failure.data?.error === "invalid_grant") {
    throw new GoogleGrantError();
  }
  throw new GoogleUnavailableError(response.status);
}

async function readJson(response: Response) {
  try {
    return z.json().parse(await response.json());
  } catch {
    return null;
  }
}

function decodeJwtPayload(jwt: string) {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    return z
      .json()
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function grantedScopes(scope: string | undefined) {
  return (scope ?? "").split(" ").filter((entry) => entry.length > 0);
}

function expiresAt(expiresInSeconds: number) {
  return Date.now() + expiresInSeconds * 1000;
}
