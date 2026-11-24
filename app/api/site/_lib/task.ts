import { ClientError, SessionNotActiveError } from "eve/client";
import type { ReceivedEvent } from "eve/events";
import { z } from "zod";
import type { siteTasks } from "@db";
import {
  countSiteTaskFiles,
  findSiteTaskSession,
  listSiteTasksOfLogin,
  readSiteTaskSignInOrigin,
} from "@db/services/sites";
import type { AccessScope } from "@shared/identity/access-scope";
import { siteTaskLifetimeMs } from "@shared/identity/site-task/lifetime";
import { siteError } from "@app/api/site/_lib/site-auth";
import { siteEveClient } from "@app/api/site/_lib/eve";
import {
  isOpen,
  siteTaskState,
  siteTaskStatus,
  type SiteTaskState,
} from "@app/api/site/_lib/status";

// A session that eve has accepted but not started yet reads as one of these.
const notReadyStatuses = new Set([404, 409, 425]);
// eve also answers 404 when the run itself is gone (a lost volume, or a crash
// before the run was stored). Past this age a 404 no longer means "starting".
const missingRunGraceMs = 120_000;
// One open task per login, so its open task is always among its newest.
const loginTaskLimit = 5;

export type SiteTask = Pick<
  typeof siteTasks.$inferSelect,
  "createdAt" | "id" | "kind" | "sessionId"
>;

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
  return { ok: true as const, task: { ...task, id: taskId } };
}

async function readSiteTaskEvents(site: string, sessionId: string) {
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

// Where one of this site's tasks stands, or 503 while eve cannot say. A task
// whose turn still runs past its lifetime reads timed_out once eve has taken
// the cancel of that turn.
export async function readSiteTaskState(site: string, task: SiteTask) {
  let events: ReceivedEvent[];
  try {
    events = await readSiteTaskEvents(site, task.sessionId);
  } catch (error) {
    return unreadTaskState(
      site,
      task,
      ClientError.is(error) ? error : undefined
    );
  }
  const { openTurn, state } = siteTaskState(
    events,
    task.createdAt,
    Date.now(),
    task.kind
  );
  if (openTurn !== undefined && !isOpen(state)) {
    const cancelled = await cancelSiteTurn(site, task.sessionId, openTurn);
    if (!cancelled.ok) return cancelled;
    console.info("[site] task passed its lifetime and was cancelled", {
      site,
    });
  }
  return { ok: true as const, openTurn, state };
}

function unreadTaskState(
  site: string,
  task: SiteTask,
  error: ClientError | undefined
) {
  const age = Date.now() - task.createdAt.getTime();
  if (error?.code === "session_expired") {
    return readState({ error: "failed", reply: null, status: "failed" });
  }
  if (error?.status === 404 && age > missingRunGraceMs) {
    console.warn("[site] task run is missing", { site });
    return readState({ error: "failed", reply: null, status: "failed" });
  }
  if (error && notReadyStatuses.has(error.status)) {
    return readState(
      age >= siteTaskLifetimeMs
        ? { error: "timed_out", reply: null, status: "failed" }
        : { status: "running" }
    );
  }
  console.warn("[site] task status unavailable", {
    error: error?.code ?? "unknown",
    site,
  });
  return { ok: false as const, response: siteError(503, "unavailable") };
}

function readState(state: SiteTaskState) {
  return { ok: true as const, openTurn: undefined, state };
}

// What a site reads for one of its tasks, or 503 while eve or the database
// cannot say. The page a refused fill recorded is read after the events: the
// worker records it before the agent can end the task with it.
export async function readSiteTaskStatus(
  site: string,
  scope: AccessScope,
  task: SiteTask
) {
  const read = await readSiteTaskState(site, task);
  if (!read.ok) return read;
  if (
    read.state.status === "failed" &&
    read.state.error === "sign_in_elsewhere"
  ) {
    let signInOrigin: string | null;
    try {
      signInOrigin = await readSiteTaskSignInOrigin(site, scope, task.id);
    } catch (error) {
      console.warn("[site] task sign-in page could not be read", {
        error: error instanceof Error ? error.name : "unknown",
        site,
      });
      return { ok: false as const, response: siteError(503, "unavailable") };
    }
    return {
      ok: true as const,
      status: siteTaskStatus(read.state, 0, signInOrigin),
    };
  }
  if (read.state.status !== "completed") {
    return { ok: true as const, status: siteTaskStatus(read.state, 0, null) };
  }
  if (task.kind === "look") {
    return {
      ok: true as const,
      status: siteTaskStatus(read.state, 0, null, task.kind),
    };
  }
  let savedFiles: number;
  try {
    savedFiles = await countSiteTaskFiles(site, scope, task.id);
  } catch (error) {
    console.warn("[site] task files could not be counted", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return { ok: false as const, response: siteError(503, "unavailable") };
  }
  return {
    ok: true as const,
    status: siteTaskStatus(read.state, savedFiles, null),
  };
}

// Cancels the site's own turn. The turn id guards it, so a later turn the
// owner started in the chat is never stopped; a session that is no longer
// active has nothing left to stop.
export async function cancelSiteTurn(
  site: string,
  sessionId: string,
  turnId: string
) {
  try {
    await siteEveClient({ op: "cancel", session: sessionId, site })
      .sessions.attach(sessionId)
      .cancel({ signal: AbortSignal.timeout(20_000), turnId });
    return { ok: true as const };
  } catch (error) {
    if (
      SessionNotActiveError.is(error) &&
      error.code === "session_not_active"
    ) {
      return { ok: true as const };
    }
    console.warn("[site] task could not be cancelled", {
      error:
        ClientError.is(error) || SessionNotActiveError.is(error)
          ? error.code
          : "unknown",
      site,
    });
    return { ok: false as const, response: siteError(503, "unavailable") };
  }
}

// The newest tasks this site pinned to the login, newest first, each read as
// GET /tasks/{id} reads it, so the reads also enforce their lifetime.
async function readTasksOfLogin(
  site: string,
  scope: AccessScope,
  loginId: string
) {
  let tasks: Awaited<ReturnType<typeof listSiteTasksOfLogin>>;
  try {
    tasks = await listSiteTasksOfLogin(site, scope, loginId, loginTaskLimit);
  } catch (error) {
    console.warn("[site] login tasks lookup failed", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return { ok: false as const, response: siteError(503, "unavailable") };
  }
  const reads = await Promise.all(
    tasks.map(async (task) => ({
      read: await readSiteTaskState(site, task),
      task,
    }))
  );
  return { ok: true as const, reads };
}

// What GET /tasks?loginId lists, or 503 while one of the tasks cannot be read.
export async function listTasksOfLogin(
  site: string,
  scope: AccessScope,
  loginId: string
) {
  const found = await readTasksOfLogin(site, scope, loginId);
  if (!found.ok) return found;
  const tasks: {
    createdAt: string;
    status: SiteTaskState["status"];
    taskId: string;
  }[] = [];
  for (const { read, task } of found.reads) {
    if (!read.ok) return read;
    tasks.push({
      createdAt: task.createdAt.toISOString(),
      status: read.state.status,
      taskId: task.id,
    });
  }
  return { ok: true as const, tasks };
}

// This site's task that still runs or waits for a code while pinned to the
// login, if any, or 503 while none is known open and one cannot be read.
export async function openTaskOfLogin(
  site: string,
  scope: AccessScope,
  loginId: string
) {
  const found = await readTasksOfLogin(site, scope, loginId);
  if (!found.ok) return found;
  const open = found.reads.find(({ read }) => read.ok && isOpen(read.state));
  if (open) return { ok: true as const, taskId: open.task.id };
  for (const { read } of found.reads) if (!read.ok) return read;
  return { ok: true as const, taskId: undefined };
}
