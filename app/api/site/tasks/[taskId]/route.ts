import { ClientError } from "eve/client";
import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";
import { siteTaskStatus } from "@app/api/site/tasks/[taskId]/_lib/status";
import {
  lookupSiteTask,
  readSiteTaskEvents,
} from "@app/api/site/tasks/[taskId]/_lib/task";

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
  const found = await lookupSiteTask(site, owner.scope, taskId);
  if (!found.ok) return found.response;
  const { task } = found;

  try {
    const events = await readSiteTaskEvents(site, task.sessionId);
    return siteJson({ taskId, ...siteTaskStatus(events) });
  } catch (error) {
    if (ClientError.is(error) && error.code === "session_expired") {
      return siteJson(failedTask(taskId, "The task record has expired."));
    }
    if (
      ClientError.is(error) &&
      error.status === 404 &&
      Date.now() - task.createdAt.getTime() > missingRunGraceMs
    ) {
      console.warn("[site] task run is missing", { site });
      return siteJson(
        failedTask(taskId, "The task record is no longer available.")
      );
    }
    if (ClientError.is(error) && notReadyStatuses.has(error.status)) {
      return siteJson({
        error: null,
        question: null,
        questionId: null,
        reply: null,
        status: "running",
        taskId,
      });
    }
    console.warn("[site] task status unavailable", {
      error: ClientError.is(error) ? error.code : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
}

function failedTask(taskId: string, error: string) {
  return {
    error,
    question: null,
    questionId: null,
    reply: null,
    status: "failed",
    taskId,
  };
}
