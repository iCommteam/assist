import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";
import { isOpen } from "@app/api/site/_lib/status";
import {
  cancelSiteTurn,
  lookupSiteTask,
  readSiteTaskState,
} from "@app/api/site/_lib/task";

// Stops a task that still runs or waits for a code; it then reads failed /
// cancelled. A task that has ended is left as it is, so a repeated cancel
// answers the same.
export async function POST(
  request: Request,
  context: RouteContext<"/api/site/tasks/[taskId]/cancel">
) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const { taskId } = await context.params;
  const { owner, site } = caller;
  const found = await lookupSiteTask(site, owner.scope, taskId);
  if (!found.ok) return found.response;

  const read = await readSiteTaskState(site, found.task);
  if (!read.ok) return read.response;
  if (isOpen(read.state)) {
    // Until its turn starts there is no turn to stop, and a cancel eve took
    // then could stop nothing, so the site retries.
    if (read.openTurn === undefined) return siteError(503, "unavailable");
    const cancelled = await cancelSiteTurn(
      site,
      found.task.sessionId,
      read.openTurn
    );
    if (!cancelled.ok) return cancelled.response;
    console.info("[site] task cancelled", { site });
  }
  return siteJson({ taskId }, 202);
}
