import { z } from "zod";
import { ensureScope } from "@db/services/scope";
import { recordSiteTask } from "@db/services/sites";
import { readSiteLoginPin } from "@db/services/vault";
import { closeLeftLoginWriters } from "@web/browser/login-profile";
import type { AccessScope } from "@shared/identity/access-scope";
import { siteLoginPinSchema } from "@shared/identity/site-credential";
import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";
import { readSiteJsonBody } from "@app/api/site/_lib/request-body";
import { siteEveClient } from "@app/api/site/_lib/eve";
import { oneUseOfLoginAtATime } from "@app/api/site/_lib/one-at-a-time";
import { listTasksOfLogin, openTaskOfLogin } from "@app/api/site/_lib/task";

const maxBodyBytes = 64 * 1024;
const taskInputSchema = z.object({
  loginId: siteLoginPinSchema.shape.id.optional(),
  message: z
    .string()
    .min(1)
    .max(8000)
    .refine((message) => message.trim().length > 0),
});
const loginIdSchema = siteLoginPinSchema.shape.id;

export async function POST(request: Request) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const input = taskInputSchema.safeParse(
    await readSiteJsonBody(request, maxBodyBytes)
  );
  if (!input.success) return siteError(400, "invalid_request");

  const { owner, site } = caller;
  const { loginId, message } = input.data;
  if (loginId === undefined) {
    return startTask(owner.scope, site, message, undefined);
  }
  // A login runs one task at a time: its browser profile keeps one sign-in.
  return oneUseOfLoginAtATime(owner.scope, site, loginId, async () => {
    const pin = await resolveLoginPin(owner.scope, site, loginId);
    if (!pin.ok) return pin.response;
    const open = await openTaskOfLogin(site, owner.scope, loginId);
    if (!open.ok) return open.response;
    if (open.taskId) {
      return siteJson({ error: "login_busy", taskId: open.taskId }, 409);
    }
    return startTask(owner.scope, site, message, pin.login);
  });
}

// The tasks this site pinned to one login, so a site that lost the answer to
// a start can find the task it started.
export async function GET(request: Request) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const loginId = loginIdSchema.safeParse(
    new URL(request.url).searchParams.get("loginId")
  );
  if (!loginId.success) return siteError(400, "invalid_request");
  const { owner, site } = caller;
  const listed = await listTasksOfLogin(site, owner.scope, loginId.data);
  if (!listed.ok) return listed.response;
  return siteJson({ tasks: listed.tasks });
}

async function startTask(
  scope: AccessScope,
  site: string,
  message: string,
  login: z.infer<typeof siteLoginPinSchema> | undefined
) {
  const start = claimStartSlot(site);
  if (!start.ok) {
    console.warn("[site] task start rate limited", { site });
    return siteError(429, "rate_limited", {
      "retry-after": String(start.retryAfterSeconds),
    });
  }
  try {
    // The task row references the workspace, which the session hook would
    // otherwise create only after eve has accepted the session.
    await ensureScope(scope);
    // Only a start that goes ahead frees the login's sign-in, still under
    // the login's lock: a refused one leaves its browsers alone.
    if (login) await closeLeftLoginWriters(scope, login.id);
    const { session } = await siteEveClient({
      login,
      op: "create",
      site,
    }).sessions.create({ message });
    const taskId = await recordStartedTask(() =>
      recordSiteTask(site, scope, session.id, login?.id)
    );
    return siteJson({ taskId }, 202);
  } catch (error) {
    console.warn("[site] task could not start", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
}

// A pinned task may use only that saved login, and its browser only that
// login's site. A site pins only a login it saved itself: the owner's own
// items, other sites' and unknown ids get the same answer, so a site learns
// nothing about the rest of the vault.
async function resolveLoginPin(
  scope: AccessScope,
  site: string,
  loginId: string
) {
  let login: Awaited<ReturnType<typeof readSiteLoginPin>>;
  try {
    login = await readSiteLoginPin(scope, site, loginId);
  } catch (error) {
    console.warn("[site] task login could not be read", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return { ok: false as const, response: siteError(503, "unavailable") };
  }
  if (!login) {
    return { ok: false as const, response: siteError(400, "invalid_request") };
  }
  return { login, ok: true as const };
}

// Every start spends model time and a browser, so a leaked token is capped per
// site. The service runs one replica, so memory holds the whole count, as it
// does for Better Auth's limits; a restart forgets it. A start that eve then
// refuses still counts.
const startWindowMs = 10 * 60_000;
const maxStartsPerWindow = 10;
const recentStarts = new Map<string, number[]>();

// Synchronous, so concurrent requests cannot all take the last slot.
function claimStartSlot(site: string) {
  const now = Date.now();
  const starts = (recentStarts.get(site) ?? []).filter(
    (startedAt) => startedAt > now - startWindowMs
  );
  recentStarts.set(site, starts);
  if (starts.length >= maxStartsPerWindow) {
    const reopensAt = Math.min(...starts) + startWindowMs;
    return {
      ok: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((reopensAt - now) / 1000)),
    };
  }
  starts.push(now);
  return { ok: true as const };
}

// eve has already started the task, so a lost row leaves it running where the
// site can never read it, and a retried POST would run it twice. A short
// retry covers a passing database error.
const recordAttempts = 3;
const recordRetryDelayMs = 250;

async function recordStartedTask(
  record: () => Promise<string>,
  attempt = 1
): Promise<string> {
  try {
    return await record();
  } catch (error) {
    if (attempt >= recordAttempts) throw error;
    await new Promise((resolve) => setTimeout(resolve, recordRetryDelayMs));
    return recordStartedTask(record, attempt + 1);
  }
}
