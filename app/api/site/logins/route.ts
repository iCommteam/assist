import { parse } from "tldts";
import { z } from "zod";
import {
  isSiteLoginLabelTaken,
  listSiteLogins,
  saveSiteLogin,
} from "@db/services/vault";
import {
  isAmazonHost,
  isIdentityProviderHost,
  stripeInvoiceHosts,
} from "@shared/browser/hosts";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  authenticatorSetupKeySchema,
  type AuthenticatorKey,
} from "@shared/vault/authenticator";
import { serializeLoginVaultPayload } from "@shared/vault/schema";
import { oneAtATime } from "@app/api/site/_lib/one-at-a-time";
import { readSiteJsonBody } from "@app/api/site/_lib/request-body";
import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";

const maxBodyBytes = 16 * 1024;
// Serializes the saves of a site in a workspace: two saves of one label at
// once cannot both pass the label check.
const savesInFlight = new Map<string, Promise<Response>>();
const controlCharacter = /\p{Cc}/u;

// The body carries a password and maybe an authenticator key: it is never
// logged, and no answer repeats any of it.
const loginInputSchema = z.object({
  alsoHosts: z
    .array(z.string().refine(isAlsoHost))
    .max(3)
    .nullish()
    .transform((hosts) => [...new Set(hosts)]),
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
  // An identity provider has its own answer, so a site can tell the person
  // that only a password sign-in on the supplier's own site works.
  const { alsoHosts, origin } = input.data;
  if ([new URL(origin).hostname, ...alsoHosts].some(isIdentityProviderHost)) {
    return siteError(400, "identity_provider");
  }
  if (alsoHosts.some((host) => isOnSiteOf(origin, host))) {
    return siteError(400, "invalid_request");
  }
  // A blank key is no key, as a form left empty sends it.
  const totpText = input.data.totp?.trim();
  const totp = totpText
    ? authenticatorSetupKeySchema.safeParse(totpText)
    : undefined;
  if (totp && !totp.success) return siteError(400, "invalid_totp");

  const { owner, site } = caller;
  return oneAtATime(savesInFlight, `${owner.scope.workspaceId}\0${site}`, () =>
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
      logins: logins.map(
        ({ alsoHosts, createdAt, hasTotp, id, label, origin }) => ({
          alsoHosts,
          createdAt,
          hasTotp,
          label,
          loginId: id,
          origin,
        })
      ),
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
        alsoHosts: login.alsoHosts,
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
          alsoHosts: login.alsoHosts,
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
  return isNamedHost(hostname) ? origin : undefined;
}

// A host the login's site also uses outside its registrable domain, such as
// a separate billing host, which the login's tasks may open but where nothing
// is filled. It is named as a browser names it, lower case with no scheme,
// port or path, and is a named host like the origin's. Stripe's invoice hosts
// are open to every pinned task already, and no browser opens Amazon.
function isAlsoHost(value: string) {
  if (value.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(value)) {
    return false;
  }
  if (!URL.canParse(`https://${value}`)) return false;
  return (
    new URL(`https://${value}`).hostname === value &&
    isNamedHost(value) &&
    !stripeInvoiceHosts.includes(value) &&
    !isAmazonHost(value)
  );
}

function isNamedHost(hostname: string) {
  const { domain, isIp } = parse(hostname, { allowPrivateDomains: true });
  if (isIp || !domain || hostname.endsWith(".")) return false;
  return hostname !== "localhost" && !hostname.endsWith(".localhost");
}

// A host under the origin's own registrable domain is the login's site
// already, so it is not one the site also uses.
function isOnSiteOf(origin: string, host: string) {
  const site = parse(new URL(origin).hostname, { allowPrivateDomains: true });
  return parse(host, { allowPrivateDomains: true }).domain === site.domain;
}
