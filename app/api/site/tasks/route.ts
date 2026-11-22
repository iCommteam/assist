import { z } from "zod";
import { ensureScope } from "@db/services/scope";
import { recordSiteTask } from "@db/services/sites";
import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";
import { siteEveClient } from "@app/api/site/tasks/_lib/eve";

const maxBodyBytes = 64 * 1024;
const taskInputSchema = z.object({
  message: z
    .string()
    .min(1)
    .max(8000)
    .refine((message) => message.trim().length > 0),
});

export async function POST(request: Request) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const input = taskInputSchema.safeParse(await readJsonBody(request));
  if (!input.success) return siteError(400, "invalid_request");

  const { owner, site } = caller;
  try {
    // The task row references the workspace, which the session hook would
    // otherwise create only after eve has accepted the session.
    await ensureScope(owner.scope);
    const { session } = await siteEveClient({
      op: "create",
      site,
    }).sessions.create({ message: input.data.message });
    const taskId = await recordSiteTask(site, owner.scope, session.id);
    return siteJson({ taskId }, 202);
  } catch (error) {
    console.warn("[site] task could not start", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
}

async function readJsonBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > maxBodyBytes) {
    return undefined;
  }
  const text = await request.text();
  if (text.length > maxBodyBytes) return undefined;
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}
