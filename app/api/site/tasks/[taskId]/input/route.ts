import { ClientError } from "eve/client";
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
import { awaitedSiteCode } from "@app/api/site/_lib/status";
import { lookupSiteTask, readSiteTaskEvents } from "@app/api/site/_lib/task";

const maxBodyBytes = 4 * 1024;
const inputSchema = z.object({ text: siteCodeSchema });

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
  const { sessionId } = found.task;
  return oneInputAtATime(sessionId, () =>
    deliverCode(site, taskId, sessionId, input.data.text)
  );
}

// The service runs one replica, so memory serializes the inputs of a task: a
// retried or doubled delivery reads the question only after the first has
// answered it, and gets 409 instead of a second answer.
const inputsInFlight = new Map<string, Promise<Response>>();

async function oneInputAtATime(
  sessionId: string,
  deliver: () => Promise<Response>
) {
  const previous = inputsInFlight.get(sessionId);
  const current = (previous ?? Promise.resolve()).then(deliver, deliver);
  inputsInFlight.set(sessionId, current);
  try {
    return await current;
  } finally {
    if (inputsInFlight.get(sessionId) === current) {
      inputsInFlight.delete(sessionId);
    }
  }
}

async function deliverCode(
  site: string,
  taskId: string,
  sessionId: string,
  code: string
) {
  let interactionId: string | undefined;
  try {
    interactionId = awaitedSiteCode(await readSiteTaskEvents(site, sessionId));
  } catch (error) {
    if (ClientError.is(error) && error.status < 500) {
      return siteError(409, "not_waiting");
    }
    console.warn("[site] task input unavailable", {
      error: ClientError.is(error) ? error.code : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
  if (!interactionId) return siteError(409, "not_waiting");

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
    if (ClientError.is(error) && error.status === 409) {
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
