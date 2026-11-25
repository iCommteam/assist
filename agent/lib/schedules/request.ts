import { createHash, timingSafeEqual } from "node:crypto";
import { extractBearerToken, type AuthFn } from "eve/channels/auth";
import { env } from "@shared/environment";
import { postLoopbackRoute } from "@shared/environment/loopback";

interface ScheduledRunRequestBodies {
  "/internal/scheduled-run/report": { runId: string };
  "/internal/scheduled-run/respond": {
    answer: string;
    leaseToken: string;
    runId: string;
  };
}

// Both callers run inside the eve server, so a callback goes straight back to
// it over loopback and never leaves the machine or passes through Next. The
// scheduled-run channel accepts only SCHEDULED_RUN_SECRET as the bearer.
export async function postScheduledRunRoute<
  Route extends keyof ScheduledRunRequestBodies,
>(route: Route, body: ScheduledRunRequestBodies[Route]) {
  if (!env.SCHEDULED_RUN_SECRET) {
    throw new Error(
      "Scheduled-run callbacks are disabled. Set SCHEDULED_RUN_SECRET."
    );
  }
  return postLoopbackRoute(route, body);
}

export async function postScheduledReport(runId: string) {
  const response = await postScheduledRunRoute(
    "/internal/scheduled-run/report",
    { runId }
  );
  if (response.status !== 202) {
    throw new Error(
      `Scheduled report callback failed (${String(response.status)}).`
    );
  }
}

// The loopback callbacks' authentication, for every channel route outside
// eve's protocol namespace (shared/environment/loopback.ts). Hashing both sides gives
// equal-length buffers for the constant-time compare. Unset, every callback
// is refused.
export const internalRouteAuth: AuthFn = (request) => {
  const secret = env.SCHEDULED_RUN_SECRET;
  const presented = extractBearerToken(request.headers.get("authorization"));
  if (!secret || !presented) return null;
  if (!timingSafeEqual(digest(presented), digest(secret))) return null;
  return {
    attributes: {},
    authenticator: "scheduled-run",
    principalId: "scheduled-run",
    principalType: "service",
  };
};

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}
