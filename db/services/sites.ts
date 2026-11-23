import { and, eq, sql } from "drizzle-orm";
import { db, siteTasks, user } from "@db";
import { siteOwnerEmail } from "@shared/environment/sites";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";
import { isAllowedEmail } from "./auth/allowlist";

// A site acts inside the personal workspace of its configured owner, and only
// while that owner could sign in: listed, registered and enrolled in TOTP.
// The refusal reason is for the server log, never for the caller.
export async function resolveSiteOwner(site: string) {
  const email = siteOwnerEmail(site);
  if (!email) return { ok: false as const, reason: "owner not configured" };
  if (!isAllowedEmail(email)) {
    return { ok: false as const, reason: "owner not on the team list" };
  }
  const [owner] = await db
    .select({ id: user.id, twoFactorEnabled: user.twoFactorEnabled })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email))
    .limit(1);
  if (!owner) return { ok: false as const, reason: "owner has no account" };
  if (!owner.twoFactorEnabled) {
    return { ok: false as const, reason: "owner has no authenticator" };
  }
  return {
    email,
    ok: true as const,
    scope: accessScopeForUser(`better-auth:${owner.id}`),
  };
}

export async function recordSiteTask(
  site: string,
  scope: AccessScope,
  sessionId: string
) {
  const [task] = await db
    .insert(siteTasks)
    .values({ sessionId, site, workspaceId: scope.workspaceId })
    .returning({ id: siteTasks.id });
  if (!task) throw new Error("The site task was not recorded.");
  return task.id;
}

// The session and creation time of a task this site created in this
// workspace, or undefined for an unknown task, another site's task, or one
// from a previous owner.
export async function findSiteTaskSession(
  site: string,
  scope: AccessScope,
  taskId: string
) {
  const [task] = await db
    .select({ createdAt: siteTasks.createdAt, sessionId: siteTasks.sessionId })
    .from(siteTasks)
    .where(
      and(
        eq(siteTasks.id, taskId),
        eq(siteTasks.site, site),
        eq(siteTasks.workspaceId, scope.workspaceId)
      )
    )
    .limit(1);
  return task;
}

export async function isSiteTaskSession(
  site: string,
  scope: AccessScope,
  sessionId: string
) {
  const [task] = await db
    .select({ id: siteTasks.id })
    .from(siteTasks)
    .where(
      and(
        eq(siteTasks.sessionId, sessionId),
        eq(siteTasks.site, site),
        eq(siteTasks.workspaceId, scope.workspaceId)
      )
    )
    .limit(1);
  return task !== undefined;
}

// Whether a session is a task that any site created in this workspace.
export async function isAnySiteTaskSession(
  scope: AccessScope,
  sessionId: string
) {
  const [task] = await db
    .select({ id: siteTasks.id })
    .from(siteTasks)
    .where(
      and(
        eq(siteTasks.sessionId, sessionId),
        eq(siteTasks.workspaceId, scope.workspaceId)
      )
    )
    .limit(1);
  return task !== undefined;
}
