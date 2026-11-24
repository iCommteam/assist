import {
  authenticateSiteRequest,
  siteJson,
} from "@app/api/site/_lib/site-auth";
import { lookupSiteTask, readSiteTaskStatus } from "@app/api/site/_lib/task";

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

  const { kind } = found.task;
  const read = await readSiteTaskStatus(site, owner.scope, found.task);
  if (!read.ok) return read.response;
  return siteJson({ kind, taskId, ...read.status });
}
