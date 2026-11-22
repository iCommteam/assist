import { ClientError } from "eve/client";
import type { ReceivedEvent } from "eve/events";
import { z } from "zod";
import { findSiteTaskSession } from "@db/services/sites";
import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";
import { siteEveClient } from "@app/api/site/tasks/_lib/eve";
import { siteTaskStatus } from "@app/api/site/tasks/[taskId]/_lib/status";

// A session that eve has accepted but not started yet reads as one of these.
const notReadyStatuses = new Set([404, 409, 425]);
// eve also answers 404 when the run itself is gone (a lost volume, or a crash
// before the run was stored). Past this age a 404 no longer means "starting".
const missingRunGraceMs = 120_000;

export async function GET(
  request: Request,
  context: RouteContext<"/api/site/tasks/[taskId]">
) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const { taskId } = await context.params;
  const { owner, site } = caller;
  const task = z.uuid().safeParse(taskId).success
    ? await findSiteTaskSession(site, owner.scope, taskId)
    : undefined;
  if (!task) return siteError(404, "not_found");
  const { sessionId } = task;

  try {
    const events: ReceivedEvent[] = [];
    const stream = siteEveClient({ op: "read", session: sessionId, site })
      .sessions.attach(sessionId)
      .stream({
        follow: false,
        reconnect: { maxAttempts: 2 },
        signal: AbortSignal.timeout(20_000),
      });
    for await (const event of stream) events.push(event);
    return siteJson({ taskId, ...siteTaskStatus(events) });
  } catch (error) {
    if (ClientError.is(error) && error.code === "session_expired") {
      return siteJson({
        error: "The task record has expired.",
        reply: null,
        status: "failed",
        taskId,
      });
    }
    if (
      ClientError.is(error) &&
      error.status === 404 &&
      Date.now() - task.createdAt.getTime() > missingRunGraceMs
    ) {
      console.warn("[site] task run is missing", { site });
      return siteJson({
        error: "The task record is no longer available.",
        reply: null,
        status: "failed",
        taskId,
      });
    }
    if (ClientError.is(error) && notReadyStatuses.has(error.status)) {
      return siteJson({ error: null, reply: null, status: "running", taskId });
    }
    console.warn("[site] task status unavailable", {
      error: ClientError.is(error) ? error.code : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
}
