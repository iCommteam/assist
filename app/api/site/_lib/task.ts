import { ClientError } from "eve/client";
import type { ReceivedEvent } from "eve/events";
import { z } from "zod";
import type { siteTasks } from "@db";
import { findSiteTaskSession, listSiteTasksOfLogin } from "@db/services/sites";
import type { AccessScope } from "@shared/identity/access-scope";
import { siteError } from "@app/api/site/_lib/site-auth";
import { siteEveClient } from "@app/api/site/_lib/eve";
import { siteTaskStatus } from "@app/api/site/_lib/status";

// A session that eve has accepted but not started yet reads as one of these.
const notReadyStatuses = new Set([404, 409, 425]);
// eve also answers 404 when the run itself is gone (a lost volume, or a crash
// before the run was stored). Past this age a 404 no longer means "starting".
const missingRunGraceMs = 120_000;
// No site task stays open longer than this.
const taskLifetimeMs = 45 * 60_000;

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

// What a site reads for one of its tasks, or 503 while eve cannot say.
export async function readSiteTaskStatus(
  site: string,
  task: Pick<typeof siteTasks.$inferSelect, "createdAt" | "sessionId">
) {
  try {
    const events = await readSiteTaskEvents(site, task.sessionId);
    return { ok: true as const, status: siteTaskStatus(events) };
  } catch (error) {
    if (ClientError.is(error) && error.code === "session_expired") {
      return {
        ok: true as const,
        status: failedTask("The task record has expired."),
      };
    }
    if (
      ClientError.is(error) &&
      error.status === 404 &&
      Date.now() - task.createdAt.getTime() > missingRunGraceMs
    ) {
      console.warn("[site] task run is missing", { site });
      return {
        ok: true as const,
        status: failedTask("The task record is no longer available."),
      };
    }
    if (ClientError.is(error) && notReadyStatuses.has(error.status)) {
      return {
        ok: true as const,
        status: {
          error: null,
          question: null,
          questionId: null,
          reply: null,
          status: "running" as const,
        },
      };
    }
    console.warn("[site] task status unavailable", {
      error: ClientError.is(error) ? error.code : "unknown",
      site,
    });
    return { ok: false as const, response: siteError(503, "unavailable") };
  }
}

// This site's task that still runs or waits for a code while pinned to the
// login, if any, or 503 while one of them cannot be read.
export async function openTaskOfLogin(
  site: string,
  scope: AccessScope,
  loginId: string
) {
  let tasks: Awaited<ReturnType<typeof listSiteTasksOfLogin>>;
  try {
    tasks = await listSiteTasksOfLogin(
      site,
      scope,
      loginId,
      new Date(Date.now() - taskLifetimeMs)
    );
  } catch (error) {
    console.warn("[site] login tasks lookup failed", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return { ok: false as const, response: siteError(503, "unavailable") };
  }
  const reads = await Promise.all(
    tasks.map(async (task) => ({
      read: await readSiteTaskStatus(site, task),
      taskId: task.id,
    }))
  );
  const open = reads.find(
    ({ read }) =>
      read.ok &&
      (read.status.status === "running" ||
        read.status.status === "awaiting-input")
  );
  if (open) return { ok: true as const, taskId: open.taskId };
  for (const { read } of reads) if (!read.ok) return read;
  return { ok: true as const, taskId: undefined };
}

function failedTask(error: string) {
  return {
    error,
    question: null,
    questionId: null,
    reply: null,
    status: "failed" as const,
  };
}
