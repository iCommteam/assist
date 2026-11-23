import { listSiteTaskFiles } from "@db/services/sites";
import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";
import { purgeExpiredFiles } from "@app/api/site/tasks/[taskId]/files/_lib/purge";
import { lookupSiteTask } from "@app/api/site/_lib/task";

// The PDFs one of this site's tasks saved and still keeps, oldest first.
export async function GET(
  request: Request,
  context: RouteContext<"/api/site/tasks/[taskId]/files">
) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const { taskId } = await context.params;
  const { owner, site } = caller;
  const found = await lookupSiteTask(site, owner.scope, taskId);
  if (!found.ok) return found.response;
  await purgeExpiredFiles(site);

  let files: Awaited<ReturnType<typeof listSiteTaskFiles>>;
  try {
    files = await listSiteTaskFiles(site, owner.scope, found.task.id);
  } catch (error) {
    console.warn("[site] task files could not be listed", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
  return siteJson({
    files: files.map((file) => ({
      byteSize: file.byteSize,
      createdAt: file.createdAt.toISOString(),
      fileId: file.fileId,
      filename: file.filename,
      mediaType: file.mediaType,
      sha256: file.sha256,
    })),
  });
}
