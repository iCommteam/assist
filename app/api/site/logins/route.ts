import { parse } from "tldts";
import { z } from "zod";
import {
  isSiteLoginLabelTaken,
  listSiteLogins,
  saveSiteLogin,
} from "@db/services/vault";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  authenticatorSetupKeySchema,
  type AuthenticatorKey,
} from "@shared/vault/authenticator";
import { serializeLoginVaultPayload } from "@shared/vault/schema";
import { readSiteJsonBody } from "@app/api/site/_lib/request-body";
import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";

const maxBodyBytes = 16 * 1024;
const controlCharacter = /\p{Cc}/u;

// The body carries a password and maybe an authenticator key: it is never
// logged, and no answer repeats any of it.
const loginInputSchema = z.object({
  identifier: z.string().trim().min(1).max(200),
  label: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .refine((label) => !controlCharacter.test(label)),
  origin: z
    .string()
    .trim()
    .max(2048)
    .transform((value, context) => {
      const origin = signInOrigin(value);
      if (origin) return origin;
      context.addIssue({ code: "custom", message: "Not a sign-in origin." });
      return z.NEVER;
    }),
  password: z.string().min(1).max(500),
  totp: z.string().max(2000).nullish(),
});

export async function POST(request: Request) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const input = loginInputSchema.safeParse(
    await readSiteJsonBody(request, maxBodyBytes)
  );
  if (!input.success) return siteError(400, "invalid_request");
  // A blank key is no key, as a form left empty sends it.
  const totpText = input.data.totp?.trim();
  const totp = totpText
    ? authenticatorSetupKeySchema.safeParse(totpText)
    : undefined;
  if (totp && !totp.success) return siteError(400, "invalid_totp");

  const { owner, site } = caller;
  return oneSaveAtATime(`${owner.scope.workspaceId}\0${site}`, () =>
    saveLogin(owner.scope, site, input.data, totp?.data)
  );
}

export async function GET(request: Request) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const { owner, site } = caller;
  try {
    const logins = await listSiteLogins(owner.scope, site);
    return siteJson({
      logins: logins.map(({ createdAt, hasTotp, id, label, origin }) => ({
        createdAt,
        hasTotp,
        label,
        loginId: id,
        origin,
      })),
    });
  } catch (error) {
    console.warn("[site] logins could not be read", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
}

async function saveLogin(
  scope: AccessScope,
  site: string,
  login: z.infer<typeof loginInputSchema>,
  totp: AuthenticatorKey | undefined
) {
  try {
    if (await isSiteLoginLabelTaken(scope, site, login.label)) {
      return siteError(409, "duplicate_label");
    }
    const saved = await saveSiteLogin(scope, site, {
      account: "",
      kind: "login",
      label: login.label,
      secret: serializeLoginVaultPayload({
        authentication: { password: login.password, totp, type: "password" },
        // An email identifier also fills email fields; any other fills the
        // username field.
        identifier: {
          type: z.email().safeParse(login.identifier).success
            ? "email"
            : "username",
          value: login.identifier,
        },
        kind: "login",
        origin: login.origin,
        version: 2,
      }),
    });
    console.info("[site] login saved", { site });
    return siteJson(
      {
        login: {
          createdAt: saved.createdAt,
          hasTotp: totp !== undefined,
          label: login.label,
          loginId: saved.id,
          origin: login.origin,
        },
      },
      201
    );
  } catch (error) {
    console.warn("[site] login could not be saved", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
}

// The service runs one replica, so memory serializes the saves of a site in a
// workspace: two saves of one label at once cannot both pass the check.
const savesInFlight = new Map<string, Promise<Response>>();

async function oneSaveAtATime(key: string, save: () => Promise<Response>) {
  const previous = savesInFlight.get(key);
  const current = (previous ?? Promise.resolve()).then(save, save);
  savesInFlight.set(key, current);
  try {
    return await current;
  } finally {
    if (savesInFlight.get(key) === current) savesInFlight.delete(key);
  }
}

// The origin of the site's sign-in page. Passwords and codes are typed only on
// it and the browser opens only its registrable domain, so it must be a named
// https host: no IP address, single label, port or user info. The authority is
// read from the text too, since the parsed URL drops a default port like :443.
function signInOrigin(value: string) {
  if (controlCharacter.test(value)) return undefined;
  const authority = /^https:\/\/([^/\\?#]*)/iu.exec(value)?.[1];
  if (!authority || authority.includes(":") || authority.includes("@")) {
    return undefined;
  }
  if (!URL.canParse(value)) return undefined;
  const { hostname, origin } = new URL(value);
  const { domain, isIp } = parse(hostname, { allowPrivateDomains: true });
  if (isIp || !domain || hostname.endsWith(".")) return undefined;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return undefined;
  }
  return origin;
}
