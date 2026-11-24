import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";
import { db, siteTasks, taskFiles, user } from "@db";
import { siteOwnerEmail } from "@shared/environment/sites";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";
import { siteTaskLifetimeMs } from "@shared/identity/site-task/lifetime";
import { isAllowedEmail } from "./auth/allowlist";

const maxFilesPerTask = 10;
// Each save, list or download deletes at most this many expired files.
const purgeBatchSize = 100;

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
  sessionId: string,
  loginId: string | undefined,
  kind: (typeof siteTasks.$inferInsert)["kind"] = "fetch"
) {
  const [task] = await db
    .insert(siteTasks)
    .values({
      kind,
      loginId: loginId ?? null,
      sessionId,
      site,
      workspaceId: scope.workspaceId,
    })
    .returning({ id: siteTasks.id });
  if (!task) throw new Error("The site task was not recorded.");
  return task.id;
}

// The newest tasks this site pinned to a login in this workspace, newest
// first.
export async function listSiteTasksOfLogin(
  site: string,
  scope: AccessScope,
  loginId: string,
  limit: number
) {
  return db
    .select({
      createdAt: siteTasks.createdAt,
      id: siteTasks.id,
      kind: siteTasks.kind,
      sessionId: siteTasks.sessionId,
    })
    .from(siteTasks)
    .where(
      and(
        eq(siteTasks.site, site),
        eq(siteTasks.loginId, loginId),
        eq(siteTasks.workspaceId, scope.workspaceId)
      )
    )
    .orderBy(desc(siteTasks.createdAt), desc(siteTasks.id))
    .limit(limit);
}

// How many files a task of this site saved that are still kept, so the
// outcome agrees with the file list.
export async function countSiteTaskFiles(
  site: string,
  scope: AccessScope,
  taskId: string
) {
  const [files] = await db
    .select({ files: count() })
    .from(taskFiles)
    .where(
      and(
        eq(taskFiles.taskId, taskId),
        eq(taskFiles.site, site),
        eq(taskFiles.workspaceId, scope.workspaceId),
        isKept()
      )
    );
  return files?.files ?? 0;
}

// A file is kept for seven days from its save, by the database's clock. An
// expired file is gone to every read before it is purged.
function isKept() {
  return gt(taskFiles.expiresAt, sql`now()`);
}

// Deletes a batch of expired files and returns how many it deleted.
export async function purgeExpiredTaskFiles() {
  const deleted = await db
    .delete(taskFiles)
    .where(
      inArray(
        taskFiles.id,
        db
          .select({ id: taskFiles.id })
          .from(taskFiles)
          .where(lte(taskFiles.expiresAt, sql`now()`))
          .limit(purgeBatchSize)
      )
    )
    .returning({ id: taskFiles.id });
  return deleted.length;
}

// The task a site session may still save files to or record a page for: one
// this site created in this workspace, whose lifetime has not run out. The
// worker passes its root session, which is the task's session.
function savingTask(site: string, scope: AccessScope, sessionId: string) {
  return and(
    eq(siteTasks.sessionId, sessionId),
    eq(siteTasks.site, site),
    eq(siteTasks.workspaceId, scope.workspaceId),
    gt(siteTasks.createdAt, new Date(Date.now() - siteTaskLifetimeMs))
  );
}

// Records the page where a session's task was refused the fill of its login,
// the latest one winning, and says whether the task was still open to take it.
export async function recordSiteTaskSignInOrigin(
  site: string,
  scope: AccessScope,
  sessionId: string,
  origin: string
) {
  const rows = await db
    .update(siteTasks)
    .set({ signInOrigin: origin })
    .where(savingTask(site, scope, sessionId))
    .returning({ id: siteTasks.id });
  return rows.length > 0;
}

// Forgets the page a session's task recorded, once a later fill shows the
// website no longer asks for the password there.
export async function clearSiteTaskSignInOrigin(
  site: string,
  scope: AccessScope,
  sessionId: string
) {
  await db
    .update(siteTasks)
    .set({ signInOrigin: null })
    .where(
      and(savingTask(site, scope, sessionId), isNotNull(siteTasks.signInOrigin))
    );
}

// The page a task of this site recorded with recordSiteTaskSignInOrigin, or
// null when it recorded none.
export async function readSiteTaskSignInOrigin(
  site: string,
  scope: AccessScope,
  taskId: string
) {
  const [task] = await db
    .select({ signInOrigin: siteTasks.signInOrigin })
    .from(siteTasks)
    .where(
      and(
        eq(siteTasks.id, taskId),
        eq(siteTasks.site, site),
        eq(siteTasks.workspaceId, scope.workspaceId)
      )
    )
    .limit(1);
  return task?.signInOrigin ?? null;
}

// Whether a session's task may save one more file, checked before the
// download; the save checks again.
export async function siteTaskFileRoom(
  site: string,
  scope: AccessScope,
  sessionId: string
) {
  const [task] = await db
    .select({ files: count(taskFiles.id) })
    .from(siteTasks)
    .leftJoin(taskFiles, and(eq(taskFiles.taskId, siteTasks.id), isKept()))
    .where(savingTask(site, scope, sessionId))
    .groupBy(siteTasks.id)
    .limit(1);
  if (!task) return "closed" as const;
  return task.files >= maxFilesPerTask ? ("full" as const) : ("open" as const);
}

// Saves a PDF the session's task fetched. The task row is locked, so two
// saves at once neither pass the cap nor store the same bytes twice; a file
// with the same bytes already kept for the task is returned instead.
export async function saveSiteTaskFile(
  site: string,
  scope: AccessScope,
  sessionId: string,
  file: { content: Buffer; filename: string; sha256: string }
) {
  return db.transaction(async (transaction) => {
    const [task] = await transaction
      .select({ id: siteTasks.id })
      .from(siteTasks)
      .where(savingTask(site, scope, sessionId))
      .limit(1)
      .for("update");
    if (!task) return { ok: false as const, reason: "closed" as const };
    const kept = await transaction
      .select({
        byteSize: taskFiles.byteSize,
        fileId: taskFiles.id,
        filename: taskFiles.filename,
        sha256: taskFiles.sha256,
      })
      .from(taskFiles)
      .where(and(eq(taskFiles.taskId, task.id), isKept()));
    const same = kept.find(({ sha256 }) => sha256 === file.sha256);
    if (same) {
      const { byteSize, fileId, filename } = same;
      return {
        alreadySaved: true,
        file: { byteSize, fileId, filename },
        ok: true as const,
      };
    }
    if (kept.length >= maxFilesPerTask) {
      return { ok: false as const, reason: "full" as const };
    }
    const [saved] = await transaction
      .insert(taskFiles)
      .values({
        byteSize: file.content.byteLength,
        content: file.content,
        filename: file.filename,
        mediaType: "application/pdf",
        sha256: file.sha256,
        site,
        taskId: task.id,
        workspaceId: scope.workspaceId,
      })
      .returning({
        byteSize: taskFiles.byteSize,
        fileId: taskFiles.id,
        filename: taskFiles.filename,
      });
    if (!saved) throw new Error("The task file was not saved.");
    return { alreadySaved: false, file: saved, ok: true as const };
  });
}

// The kept files of a task of this site, oldest first, without their bytes.
export async function listSiteTaskFiles(
  site: string,
  scope: AccessScope,
  taskId: string
) {
  return db
    .select({
      byteSize: taskFiles.byteSize,
      createdAt: taskFiles.createdAt,
      fileId: taskFiles.id,
      filename: taskFiles.filename,
      mediaType: taskFiles.mediaType,
      sha256: taskFiles.sha256,
    })
    .from(taskFiles)
    .where(
      and(
        eq(taskFiles.taskId, taskId),
        eq(taskFiles.site, site),
        eq(taskFiles.workspaceId, scope.workspaceId),
        isKept()
      )
    )
    .orderBy(asc(taskFiles.createdAt), asc(taskFiles.id));
}

// One kept file of a task of this site, with its bytes, or undefined.
export async function readSiteTaskFile(
  site: string,
  scope: AccessScope,
  taskId: string,
  fileId: string
) {
  const [file] = await db
    .select({
      byteSize: taskFiles.byteSize,
      content: taskFiles.content,
      sha256: taskFiles.sha256,
    })
    .from(taskFiles)
    .where(
      and(
        eq(taskFiles.id, fileId),
        eq(taskFiles.taskId, taskId),
        eq(taskFiles.site, site),
        eq(taskFiles.workspaceId, scope.workspaceId),
        isKept()
      )
    )
    .limit(1);
  return file;
}

// The session, creation time and kind of a task this site created in this
// workspace, or undefined for an unknown task, another site's task, or one
// from a previous owner.
export async function findSiteTaskSession(
  site: string,
  scope: AccessScope,
  taskId: string
) {
  const [task] = await db
    .select({
      createdAt: siteTasks.createdAt,
      kind: siteTasks.kind,
      sessionId: siteTasks.sessionId,
    })
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
