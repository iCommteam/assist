import type { ReceivedEvent } from "eve/events";
import { z } from "zod";
import { findSiteTaskSession } from "@db/services/sites";
import type { AccessScope } from "@shared/identity/access-scope";
import { siteError } from "@app/api/site/_lib/site-auth";
import { siteEveClient } from "@app/api/site/tasks/_lib/eve";

// A task this site created in its owner's workspace. Anything else, including
// an id that is not a task id, reads as not found.
export async function lookupSiteTask(
  site: string,
  scope: AccessScope,
  taskId: string
) {
  let task: Awaited<ReturnType<typeof findSiteTaskSession>>;
  try {
    task = z.uuid().safeParse(taskId).success
      ? await findSiteTaskSession(site, scope, taskId)
      : undefined;
  } catch (error) {
    console.warn("[site] task lookup failed", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return { ok: false as const, response: siteError(503, "unavailable") };
  }
  if (!task) {
    return { ok: false as const, response: siteError(404, "not_found") };
  }
  return { ok: true as const, task };
}

export async function readSiteTaskEvents(site: string, sessionId: string) {
  const events: ReceivedEvent[] = [];
  const stream = siteEveClient({ op: "read", session: sessionId, site })
    .sessions.attach(sessionId)
    .stream({
      follow: false,
      reconnect: { maxAttempts: 2 },
      signal: AbortSignal.timeout(20_000),
    });
  for await (const event of stream) events.push(event);
  return events;
}
