import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  siteLoginPinSchema,
  type SiteGrant,
} from "@shared/identity/site-credential";

// The authenticator of a connected site acting for its owner. The eve channel
// is the only issuer; its `site` attribute records which site sent the task.
const siteAuthenticator = "assist-site";

// The principal the eve channel gives a verified site credential. A create
// grant's login pin becomes attributes of the session's initiator: its id, its
// origin and, when it has any, the hosts its site also uses.
export function sitePrincipal(
  grant: SiteGrant,
  email: string,
  scope: AccessScope
) {
  const attributes = {
    conversationChannel: "eve",
    email,
    site: grant.site,
    workspaceId: scope.workspaceId,
  };
  const login = grant.op === "create" ? grant.login : undefined;
  const pinned = login && {
    ...attributes,
    siteLogin: login.id,
    siteLoginOrigin: login.origin,
  };
  return {
    attributes: pinned
      ? login.alsoHosts?.length
        ? { ...pinned, siteLoginAlsoHosts: login.alsoHosts }
        : pinned
      : attributes,
    authenticator: siteAuthenticator,
    principalId: scope.userId,
    principalType: "user",
  } satisfies SessionAuthContext;
}

// The site that created a session, or undefined for every other session.
export function siteOfSession(initiator: SessionAuthContext | null) {
  if (initiator?.authenticator !== siteAuthenticator) return undefined;
  const site = z.string().min(1).safeParse(initiator.attributes.site);
  return site.success ? site.data : undefined;
}

// The saved login a site task is pinned to, or undefined when it has none or
// is not a site task. It is read from the initiator only, so the pin holds for
// every later turn of the session, whoever sends it. A task started before a
// pin could carry the hosts its login's site also uses reads as having none.
export function siteLoginOfSession(initiator: SessionAuthContext | null) {
  if (!siteOfSession(initiator)) return undefined;
  const login = siteLoginPinSchema.safeParse({
    alsoHosts: initiator?.attributes.siteLoginAlsoHosts,
    id: initiator?.attributes.siteLogin,
    origin: initiator?.attributes.siteLoginOrigin,
  });
  return login.success
    ? { ...login.data, alsoHosts: login.data.alsoHosts ?? [] }
    : undefined;
}
