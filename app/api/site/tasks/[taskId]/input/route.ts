import { ClientError, SessionNotActiveError } from "eve/client";
import { z } from "zod";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { sealSiteCode, siteCodeSchema } from "@shared/identity/site-code/seal";
import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";
import { readSiteJsonBody } from "@app/api/site/_lib/request-body";
import { siteEveClient } from "@app/api/site/_lib/eve";
import { oneAtATime } from "@app/api/site/_lib/one-at-a-time";
import {
  lookupSiteTask,
  readSiteTaskState,
  type SiteTask,
} from "@app/api/site/_lib/task";

const maxBodyBytes = 4 * 1024;
const inputSchema = z.object({ text: siteCodeSchema });
// Serializes the inputs of a task: a retried or doubled delivery reads the
// question only after the first has answered it, and gets 409 instead of a
// second answer.
const inputsInFlight = new Map<string, Promise<Response>>();

// The text is a one-time code: it is never logged, and it reaches eve only
// sealed, so a model, eve's records and the browser trace never hold it.
export async function POST(
  request: Request,
  context: RouteContext<"/api/site/tasks/[taskId]/input">
) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const input = inputSchema.safeParse(
    await readSiteJsonBody(request, maxBodyBytes)
  );
  if (!input.success) return siteError(400, "invalid_request");
  const { taskId } = await context.params;
  const { owner, site } = caller;
  const found = await lookupSiteTask(site, owner.scope, taskId);
  if (!found.ok) return found.response;
  return oneAtATime(inputsInFlight, found.task.sessionId, () =>
    deliverCode(site, found.task, input.data.text)
  );
}

// A task past its lifetime waits for nothing, so its code is never typed.
async function deliverCode(site: string, task: SiteTask, code: string) {
  const read = await readSiteTaskState(site, task);
  if (!read.ok) return read.response;
  if (read.state.status !== "awaiting-input") {
    return siteError(409, "not_waiting");
  }
  const { interactionId } = read.state;
  const { id: taskId, sessionId } = task;

  try {
    const { betterAuthSecret } = await getInstallationSecrets();
    await siteEveClient({
      interaction: interactionId,
      op: "answer",
      session: sessionId,
      site,
    })
      .sessions.attach(sessionId)
      .respond([
        {
          interactionId,
          text: sealSiteCode(betterAuthSecret, sessionId, code),
        },
      ]);
  } catch (error) {
    if (
      SessionNotActiveError.is(error) ||
      (ClientError.is(error) && error.status === 409)
    ) {
      return siteError(409, "not_waiting");
    }
    console.warn("[site] task input could not be delivered", {
      error: ClientError.is(error) ? error.code : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
  console.info("[site] task input delivered", { site });
  return siteJson({ taskId }, 202);
}
