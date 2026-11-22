import { eveChannel } from "eve/channels/eve";
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
  isSiteCredential,
  verifySiteCredential,
  type SiteGrant,
} from "@shared/identity/site-credential";
import { getAuthSession } from "@db/services/auth/session";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { isSiteTaskSession, resolveSiteOwner } from "@db/services/sites";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { settledToolResult } from "@agent/lib/settled-tool-result";
import { siteAuthenticator } from "@agent/lib/site-principal";
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
// Its credential covers exactly one route: creating a session, or reading the
// stream of one session the same site created.
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
    !(await isSiteTaskSession(grant.site, owner.scope, sessionId))
  ) {
    throw new ForbiddenError({ message: "Session not found." });
  }
  await requireOwnedRouteSubject(owner.scope, request);

  return {
    attributes: {
      conversationChannel: "eve",
      email: owner.email,
      site: grant.site,
      workspaceId: owner.scope.workspaceId,
    },
    authenticator: siteAuthenticator,
    principalId: owner.scope.userId,
    principalType: "user",
  };
}

function siteRouteSession(request: Request, grant: SiteGrant) {
  const { pathname } = new URL(request.url);
  if (
    grant.op === "create" &&
    request.method === "POST" &&
    pathname === "/eve/v1/session"
  ) {
    return undefined;
  }
  const streamSession = /^\/eve\/v1\/session\/([^/]+)\/stream$/.exec(
    pathname
  )?.[1];
  if (
    grant.op === "read" &&
    request.method === "GET" &&
    streamSession !== undefined &&
    decodePathSegment(streamSession) === grant.session
  ) {
    return grant.session;
  }
  throw new ForbiddenError({ message: "Session not found." });
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
