import { eveChannel } from "eve/channels/eve";
import { z } from "zod";
import {
  extractBearerToken,
  ForbiddenError,
  routeAuth,
  UnauthenticatedError,
} from "eve/channels/auth";
import { isSessionOwned } from "@db/services/sessions";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";
import {
  isSiteChatGrant,
  isSiteCredential,
  verifySiteCredential,
  type SiteGrant,
} from "@shared/identity/site-credential";
import { getAuthSession } from "@db/services/auth/session";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import {
  isAnySiteChatSession,
  isSiteChatSession,
} from "@db/services/site-chats";
import {
  isAnySiteTaskSession,
  isSiteTaskSession,
  resolveSiteOwner,
} from "@db/services/sites";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { settledToolResult } from "@agent/lib/settled-tool-result";
import { sitePrincipal } from "@agent/lib/site-principal";
import {
  finalizeScheduledReportDelivery,
  releaseScheduledReportDelivery,
  scheduledReportFromSession,
} from "@agent/lib/schedules/report-lifecycle";

const authenticate: Parameters<typeof routeAuth>[1] = [
  // The site API's internal credential. A request that presents one is decided
  // here: an invalid one is refused, never passed on to the other strategies.
  async (request) => {
    const credential = extractBearerToken(request.headers.get("authorization"));
    if (!credential || !isSiteCredential(credential)) return null;
    return authenticateSite(request, credential);
  },
  async (request) => {
    const identity = await requestIdentityFromRequest(request);
    if (!identity) return null;
    const { email, scope } = identity;

    await requireOwnedRouteSubject(scope, request);
    await refuseSiteChatSessions(request);
    await refuseSiteTaskAnswers(scope, request);

    return {
      attributes: {
        conversationChannel: "eve",
        email,
        workspaceId: scope.workspaceId,
      },
      authenticator: "authjs",
      principalId: scope.userId,
      principalType: "user",
    };
  },
  () => {
    throw new UnauthenticatedError({
      code: "authentication_required",
      message: "Sign in to continue.",
    });
  },
];

const channel = eveChannel({
  auth: authenticate,
  events: {
    async "call.settled"(event, ctx) {
      const message = sendMessageToolResultSchema.safeParse(
        settledToolResult(event, ctx.view)
      );
      if (message.success) {
        await finalizeScheduledReportDelivery(ctx);
      }
    },
    async "turn.settled"(event, ctx) {
      switch (event.data.outcome) {
        case "completed":
          if (scheduledReportFromSession(ctx)) {
            await finalizeScheduledReportDelivery(ctx, "suppressed");
          }
          return;
        case "cancelled":
          await releaseScheduledReportDelivery(
            ctx,
            "Scheduled result reporting was cancelled."
          );
          return;
        case "failed":
          await releaseScheduledReportDelivery(
            ctx,
            event.data.error?.message ?? "The scheduled report turn failed."
          );
          return;
        default:
          return;
      }
    },
    async "session.ended"(_event, ctx) {
      if (scheduledReportFromSession(ctx)) {
        await finalizeScheduledReportDelivery(ctx, "suppressed");
      }
    },
  },
});

// Eve callback handlers authenticate their capability tokens internally. Apply
// this app's caller and workspace ownership policy at the public route boundary.
const ownedCallbackRoutes = new Set([
  "/eve/v1/connections/:name/callback/:attemptId/:token",
  "/eve/v1/connections/:name/callback/:token",
  "/eve/v1/callback/:token",
]);

export default {
  ...channel,
  // oxlint-disable-next-line oxc/no-map-spread -- Keep Eve's original route definitions intact when adding the app authorization boundary.
  routes: channel.routes.map((route) => {
    if (
      route.transport === "websocket" ||
      !ownedCallbackRoutes.has(route.path)
    ) {
      return route;
    }
    return {
      ...route,
      async handler(request, context) {
        const principal = await routeAuth(request, authenticate);
        if (principal instanceof Response) return principal;
        return route.handler(request, context);
      },
    };
  }),
} satisfies typeof channel;

// Routes without a session subject. Every other eve route must name a session
// this caller owns, either in the path or inside a hook token.
const subjectFreeRoutes = new Set([
  "/eve/v1/health",
  "/eve/v1/info",
  "/eve/v1/session",
]);

async function requireOwnedRouteSubject(scope: AccessScope, request: Request) {
  const { pathname } = new URL(request.url);
  if (subjectFreeRoutes.has(pathname)) return;
  const sessionId = sessionIdFromPath(pathname);
  if (!sessionId || !(await waitForSessionOwnership(scope, sessionId))) {
    throw new ForbiddenError({ message: "Session not found." });
  }
}

export function sessionIdFromPath(pathname: string) {
  const session = /^\/eve\/v1\/session\/([^/]+)/.exec(pathname)?.[1];
  if (session) return decodePathSegment(session);
  const hookToken =
    /^\/eve\/v1\/(?:callback|connections\/[^/]+\/callback(?:\/[^/]+)?)\/([^/]+)$/.exec(
      pathname
    )?.[1];
  const token = hookToken ? decodePathSegment(hookToken) : undefined;
  return token ? sessionIdFromHookToken(token) : undefined;
}

// Current inbox tokens wrap `eve:session:<id>:inbox` in `eve:inbox:v1:`.
// Earlier session, turn-control, and authorization token formats remain valid.
function sessionIdFromHookToken(token: string) {
  const inboxPrefix = "eve:inbox:v1:";
  const subject = token.startsWith(inboxPrefix)
    ? token.slice(inboxPrefix.length)
    : token;
  return (
    /^eve:session:([^:]+):inbox$/.exec(subject)?.[1] ??
    /^([^:]+):turn-control:\d+(?::(?:cancel|inbox))?$/.exec(subject)?.[1] ??
    /^([^:]+):auth$/.exec(subject)?.[1]
  );
}

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

// A connected site acts as its owner, with its name recorded on the session.
// Its credential covers exactly one route: creating a session, reading the
// stream of one session the same site created, answering one question in that
// session, or cancelling its work; for a chat, also sending it a message. A
// task credential reaches only the site's tasks, and a chat credential only
// that chat of that site's person.
async function authenticateSite(request: Request, credential: string) {
  const { betterAuthSecret } = await getInstallationSecrets();
  const grant = verifySiteCredential(betterAuthSecret, credential);
  if (!grant) {
    throw new UnauthenticatedError({
      code: "authentication_required",
      message: "Sign in to continue.",
    });
  }
  const sessionId = siteRouteSession(request, grant);
  await requireSiteBody(request, grant);
  const owner = await resolveSiteOwner(grant.site);
  if (!owner.ok) {
    console.warn("[site] eve call refused", {
      reason: owner.reason,
      site: grant.site,
    });
    throw new ForbiddenError({ message: "Site access is unavailable." });
  }
  if (
    sessionId !== undefined &&
    !(await (isSiteChatGrant(grant)
      ? isSiteChatSession(
          grant.site,
          owner.scope,
          grant.siteUser,
          grant.chat,
          sessionId
        )
      : isSiteTaskSession(grant.site, owner.scope, sessionId)))
  ) {
    throw new ForbiddenError({ message: "Session not found." });
  }
  await requireOwnedRouteSubject(owner.scope, request);

  return sitePrincipal(grant, owner.email, owner.scope);
}

// The one eve route each operation may call, and the session it names.
const siteRoutes = {
  answer: "message",
  cancel: "cancel",
  "chat.answer": "message",
  "chat.cancel": "cancel",
  "chat.create": "create",
  "chat.message": "message",
  "chat.read": "stream",
  create: "create",
  read: "stream",
} as const satisfies Record<SiteGrant["op"], string>;

const siteRoutePatterns = {
  cancel: { method: "POST", path: /^\/eve\/v1\/session\/([^/]+)\/cancel$/u },
  message: { method: "POST", path: /^\/eve\/v1\/session\/([^/]+)$/u },
  stream: { method: "GET", path: /^\/eve\/v1\/session\/([^/]+)\/stream$/u },
} as const;

function siteRouteSession(request: Request, grant: SiteGrant) {
  const { pathname } = new URL(request.url);
  const route = siteRoutes[grant.op];
  if (route === "create") {
    if (request.method === "POST" && pathname === "/eve/v1/session") {
      return undefined;
    }
    throw new ForbiddenError({ message: "Session not found." });
  }
  const { method, path } = siteRoutePatterns[route];
  const session = path.exec(pathname)?.[1];
  if (
    "session" in grant &&
    request.method === method &&
    session !== undefined &&
    decodePathSegment(session) === grant.session
  ) {
    return grant.session;
  }
  throw new ForbiddenError({ message: "Session not found." });
}

const siteAnswerSchema = z.strictObject({
  answers: z.tuple([
    z.strictObject({ interactionId: z.string(), text: z.string() }),
  ]),
});
// A chat's question may be answered by one of its options or in words.
const siteChatAnswerSchema = z.strictObject({
  answers: z.tuple([
    z.union([
      z.strictObject({ interactionId: z.string(), optionId: z.string() }),
      z.strictObject({ interactionId: z.string(), text: z.string() }),
    ]),
  ]),
});
const siteChatMessageSchema = z.strictObject({
  clientContext: z.json().optional(),
  message: z.string(),
});

// The session route takes both messages, which start a turn the model reads,
// and answers. An answer credential may send only its one answer, a chat's
// message credential only a text message, and a chat's create starts no turn.
async function requireSiteBody(request: Request, grant: SiteGrant) {
  switch (grant.op) {
    case "answer": {
      const body = siteAnswerSchema.safeParse(await jsonBody(request));
      if (body.data?.answers[0].interactionId === grant.interaction) return;
      break;
    }
    case "chat.answer": {
      const body = siteChatAnswerSchema.safeParse(await jsonBody(request));
      if (body.data?.answers[0].interactionId === grant.interaction) return;
      break;
    }
    case "chat.message":
      if (siteChatMessageSchema.safeParse(await jsonBody(request)).success) {
        return;
      }
      break;
    case "chat.create":
      if ((await request.clone().text()).trim() === "") return;
      break;
    default:
      return;
  }
  throw new ForbiddenError({ message: "Session not found." });
}

async function jsonBody(request: Request) {
  try {
    return z.json().parse(await request.clone().json());
  } catch {
    return undefined;
  }
}

// A site chat is its person's alone: the owner's own sign-in reaches none of
// its routes, stream, messages, answers and controls, callbacks included.
async function refuseSiteChatSessions(request: Request) {
  const sessionId = sessionIdFromPath(new URL(request.url).pathname);
  if (sessionId && (await isAnySiteChatSession(sessionId))) {
    throw new ForbiddenError({ message: "Session not found." });
  }
}

const answersBodySchema = z.object({
  answers: z.array(z.object({ interactionId: z.string() })).min(1),
});

// A site task waits only on its one-time code question, which the site
// answers through the site API: the API seals the code before eve sees it. A
// code typed in the chat would reach the task in plain text, end it, and stay
// in the session's records, so a signed-in member cannot answer there.
async function refuseSiteTaskAnswers(scope: AccessScope, request: Request) {
  if (request.method !== "POST") return;
  const session = /^\/eve\/v1\/session\/([^/]+)$/.exec(
    new URL(request.url).pathname
  )?.[1];
  const sessionId = session ? decodePathSegment(session) : undefined;
  if (!sessionId) return;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return;
  }
  if (
    answersBodySchema.safeParse(body).success &&
    (await isAnySiteTaskSession(scope, sessionId))
  ) {
    throw new ForbiddenError({
      message: "Only the site that started this task can answer its question.",
    });
  }
}

async function requestIdentityFromRequest(request: Request) {
  const session = await getAuthSession(request.headers);
  if (!session) return undefined;

  return {
    email: session.user.email,
    scope: accessScopeForUser(`better-auth:${session.user.id}`),
  };
}

async function waitForSessionOwnership(scope: AccessScope, sessionId: string) {
  /* oxlint-disable eslint/no-await-in-loop -- Ownership visibility is checked by a bounded sequential retry loop. */
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isSessionOwned(scope, sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return false;
}
