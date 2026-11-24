import { relations, sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

// Which connected site created which agent session. A site reads only the
// tasks it created; the session itself belongs to the site owner's workspace.
export const siteTasks = pgTable(
  "site_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    site: text("site").notNull(),
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id").notNull().unique(),
    // The saved login the task is pinned to, or null for a task without one.
    // It outlives the login, so it is not a foreign key.
    loginId: text("login_id"),
    // The https origin of a page on the pinned login's site, other than the
    // origin it was saved with, where the browser worker last tried to fill
    // the login and was refused. The server writes it; a model never does.
    signInOrigin: text("sign_in_origin"),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "site_tasks_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    index("site_tasks_site_idx").on(table.site, table.createdAt.desc()),
    index("site_tasks_site_login_idx").on(
      table.site,
      table.loginId,
      table.createdAt.desc()
    ),
  ]
);

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

const maxTaskFileBytes = 20 * 1024 * 1024;

// The PDFs a site task saved, kept for the site to download for seven days.
export const taskFiles = pgTable(
  "task_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    site: text("site").notNull(),
    workspaceId: text("workspace_id").notNull(),
    taskId: uuid("task_id").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type", { enum: ["application/pdf"] }).notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    content: bytea("content").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .default(sql`now() + interval '7 days'`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "task_files_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "task_files_task_id_fkey",
      columns: [table.taskId],
      foreignColumns: [siteTasks.id],
    }).onDelete("cascade"),
    check(
      "task_files_media_type_check",
      sql`${table.mediaType} = 'application/pdf'`
    ),
    check(
      "task_files_byte_size_check",
      sql`${table.byteSize} BETWEEN 1 AND ${sql.raw(String(maxTaskFileBytes))} AND octet_length(${table.content}) = ${table.byteSize}`
    ),
    check("task_files_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    index("task_files_task_idx").on(table.taskId, table.createdAt),
    index("task_files_expires_idx").on(table.expiresAt),
  ]
);

export const siteTasksRelations = relations(siteTasks, ({ many, one }) => ({
  files: many(taskFiles),
  workspace: one(workspaces, {
    fields: [siteTasks.workspaceId],
    references: [workspaces.id],
  }),
}));

export const taskFilesRelations = relations(taskFiles, ({ one }) => ({
  task: one(siteTasks, {
    fields: [taskFiles.taskId],
    references: [siteTasks.id],
  }),
  workspace: one(workspaces, {
    fields: [taskFiles.workspaceId],
    references: [workspaces.id],
  }),
}));
