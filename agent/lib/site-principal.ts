import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  isSiteChatGrant,
  siteLoginPinSchema,
  siteUserSchema,
  type SiteGrant,
} from "@shared/identity/site-credential";

// The authenticators of a connected site acting for its owner: one for a
// task, one for a chat with one of the site's people. The eve channel is the
// only issuer; the `site` attribute records which site sent it.
const siteAuthenticator = "assist-site";
const siteChatAuthenticator = "assist-site-chat";

// The principal the eve channel gives a verified site credential. A create
// grant's login pin becomes attributes of the session's initiator: its id, its
// origin and, when it has any, the hosts its site also uses. A chat grant
// records the chat and the site's person instead, and never a pin.
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
  if (isSiteChatGrant(grant)) {
    return {
      attributes: {
        ...attributes,
        siteChat: grant.chat,
        siteUser: grant.siteUser,
      },
      authenticator: siteChatAuthenticator,
      principalId: scope.userId,
      principalType: "user",
    } satisfies SessionAuthContext;
  }
  const login = grant.op === "create" ? grant.login : undefined;
  const pinned = login && {
    ...attributes,
    siteLogin: login.id,
    siteLoginOrigin: login.origin,
  };
  const withHosts = pinned
    ? login.alsoHosts?.length
      ? { ...pinned, siteLoginAlsoHosts: login.alsoHosts }
      : pinned
    : attributes;
  return {
    attributes:
      grant.op === "create" && grant.kind === "look"
        ? { ...withHosts, siteTaskKind: "look" }
        : withHosts,
    authenticator: siteAuthenticator,
    principalId: scope.userId,
    principalType: "user",
  } satisfies SessionAuthContext;
}

// Whether a site created the session as a task or as a chat, or undefined for
// every other session. It is read from the initiator only, so it holds for
// every later turn of the session, whoever sends it.
export function siteKindOfSession(initiator: SessionAuthContext | null) {
  if (!z.string().min(1).safeParse(initiator?.attributes.site).success) {
    return undefined;
  }
  if (initiator?.authenticator === siteAuthenticator) return "task" as const;
  if (initiator?.authenticator === siteChatAuthenticator) {
    return "chat" as const;
  }
  return undefined;
}

// The site that created a session, task or chat, or undefined for every other
// session.
export function siteOfSession(initiator: SessionAuthContext | null) {
  if (!siteKindOfSession(initiator)) return undefined;
  return z.string().parse(initiator?.attributes.site);
}

const siteChatAttributesSchema = z.object({
  site: z.string().min(1),
  siteChat: z.uuid(),
  siteUser: siteUserSchema,
});

// The chat a site chat session belongs to and the site's person it is for,
// or undefined for every other session.
export function siteChatOfSession(initiator: SessionAuthContext | null) {
  if (siteKindOfSession(initiator) !== "chat") return undefined;
  const chat = siteChatAttributesSchema.safeParse(initiator?.attributes);
  return chat.success
    ? {
        chatId: chat.data.siteChat,
        site: chat.data.site,
        siteUser: chat.data.siteUser,
      }
    : undefined;
}

// Whether a site task is a look, which lists what its account holds and saves
// nothing, or a fetch, which brings files back; undefined for a chat and for
// every other session. A task started before looks existed is a fetch.
export function siteTaskKindOfSession(initiator: SessionAuthContext | null) {
  if (siteKindOfSession(initiator) !== "task") return undefined;
  return initiator?.attributes.siteTaskKind === "look"
    ? ("look" as const)
    : ("fetch" as const);
}

// The saved login a site task is pinned to, or undefined when it has none or
// is not a site task; a chat never has one. It is read from the initiator
// only, so the pin holds for every later turn of the session, whoever sends
// it. A task started before a pin could carry the hosts its login's site also
// uses reads as having none.
export function siteLoginOfSession(initiator: SessionAuthContext | null) {
  if (siteKindOfSession(initiator) !== "task") return undefined;
  const login = siteLoginPinSchema.safeParse({
    alsoHosts: initiator?.attributes.siteLoginAlsoHosts,
    id: initiator?.attributes.siteLogin,
    origin: initiator?.attributes.siteLoginOrigin,
  });
  return login.success
    ? { ...login.data, alsoHosts: login.data.alsoHosts ?? [] }
    : undefined;
}
