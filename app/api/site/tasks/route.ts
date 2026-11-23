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
    await ensureScope(owner.scope);
    const { session } = await siteEveClient({
      op: "create",
      site,
    }).sessions.create({ message: input.data.message });
    const taskId = await recordStartedTask(() =>
      recordSiteTask(site, owner.scope, session.id)
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
