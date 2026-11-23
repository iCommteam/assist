import { z } from "zod";
import { readSiteTaskFile } from "@db/services/sites";
import {
  authenticateSiteRequest,
  siteError,
} from "@app/api/site/_lib/site-auth";
import { purgeExpiredFiles } from "@app/api/site/tasks/[taskId]/files/_lib/purge";
import { lookupSiteTask } from "@app/api/site/_lib/task";

// The bytes of one PDF a task of this site saved, until its seven days end.
export async function GET(
  request: Request,
  context: RouteContext<"/api/site/tasks/[taskId]/files/[fileId]">
) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const { fileId, taskId } = await context.params;
  const { owner, site } = caller;
  const found = await lookupSiteTask(site, owner.scope, taskId);
  if (!found.ok) return found.response;
  if (!z.uuid().safeParse(fileId).success) return siteError(404, "not_found");
  await purgeExpiredFiles(site);

  let file: Awaited<ReturnType<typeof readSiteTaskFile>>;
  try {
    file = await readSiteTaskFile(site, owner.scope, found.task.id, fileId);
  } catch (error) {
    console.warn("[site] task file could not be read", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
  if (!file) return siteError(404, "not_found");
  return new Response(new Uint8Array(file.content), {
    headers: {
      "cache-control": "no-store",
      "content-disposition": "attachment",
      "content-length": String(file.byteSize),
      "content-type": "application/pdf",
      "x-content-sha256": file.sha256,
    },
    status: 200,
  });
}
