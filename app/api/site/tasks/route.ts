import { z } from "zod";
import { ensureScope } from "@db/services/scope";
import { recordSiteTask } from "@db/services/sites";
import { readSiteLoginPin } from "@db/services/vault";
import { closeLeftLoginWriters } from "@web/browser/login-profile";
import {
  isAmazonHost,
  isInsideFence,
  siteNavigationFence,
} from "@shared/browser/hosts";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  siteLoginPinSchema,
  siteTaskNoteSchema,
  type SiteGrant,
} from "@shared/identity/site-credential";
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
  // A look lists what the login's account holds and saves nothing, so it
  // needs a login; leaving it out, as earlier sites do, fetches.
  kind: z.enum(["fetch", "look"]).default("fetch"),
  loginId: siteLoginPinSchema.shape.id.optional(),
  message: z
    .string()
    .min(1)
    .max(8000)
    .refine((message) => message.trim().length > 0),
  // Read on its own below, since a note that fails has its own answer.
  note: z.unknown().optional(),
});
const loginIdSchema = siteLoginPinSchema.shape.id;
// The owner's note for the pinned login's account, which a site sends with
// a task on that login; leaving it out, or null, sends none.
const noteInputSchema = siteTaskNoteSchema.nullish();

export async function POST(request: Request) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const input = taskInputSchema.safeParse(
    await readSiteJsonBody(request, maxBodyBytes)
  );
  if (!input.success) return siteError(400, "invalid_request");
  // A note is checked before anything is looked up or started, and only a
  // pinned task has an account, and a fence, for it to be about.
  const noteInput = noteInputSchema.safeParse(input.data.note);
  const note = noteInput.data ?? undefined;
  if (
    !noteInput.success ||
    (note !== undefined && input.data.loginId === undefined)
  ) {
    return siteError(400, "invalid_input");
  }

  const { owner, site } = caller;
  const { kind, loginId, message } = input.data;
  if (loginId === undefined) {
    if (kind === "look") return siteError(400, "invalid_request");
    return startTask(owner.scope, site, message, undefined, kind, undefined);
  }
  // A login runs one task at a time: its browser profile keeps one sign-in.
  return oneUseOfLoginAtATime(owner.scope, site, loginId, async () => {
    const pin = await resolveLoginPin(owner.scope, site, loginId);
    if (!pin.ok) return pin.response;
    if (note !== undefined && !isNoteOnFence(note, pin.login)) {
      return siteError(400, "invalid_input");
    }
    const open = await openTaskOfLogin(site, owner.scope, loginId);
    if (!open.ok) return open.response;
    if (open.taskId) {
      return siteJson({ error: "login_busy", taskId: open.taskId }, 409);
    }
    return startTask(owner.scope, site, message, pin.login, kind, note);
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
  login: z.infer<typeof siteLoginPinSchema> | undefined,
  kind: z.infer<typeof taskInputSchema>["kind"],
  note: string | undefined
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
    const grant: Extract<SiteGrant, { op: "create" }> = {
      login,
      op: "create",
      site,
    };
    if (kind === "look") grant.kind = kind;
    if (note !== undefined) grant.note = note;
    const { session } = await siteEveClient(grant).sessions.create({
      message,
    });
    const taskId = await recordStartedTask(() =>
      recordSiteTask(site, scope, session.id, login?.id, kind)
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

// A note may name the account's pages, never a page the task could not open:
// every https address in it must be on the fence the browser worker keeps
// for the login, which refuses Amazon before it. An address that does not
// parse, or carries a user name or password, names no page on it.
function isNoteOnFence(
  note: string,
  login: z.infer<typeof siteLoginPinSchema>
) {
  const fence = siteNavigationFence(login.origin, login.alsoHosts);
  return [...note.matchAll(/https:[/\\]{2}\S*/giu)].every(([address]) => {
    const text = address.replace(/[.,;:!?'"’”»)\]}>]+$/u, "");
    if (!URL.canParse(text)) return false;
    const { hostname, password, username } = new URL(text);
    return (
      username === "" &&
      password === "" &&
      !isAmazonHost(hostname) &&
      isInsideFence(hostname, fence)
    );
  });
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
