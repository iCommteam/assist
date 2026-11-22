import { relations } from "drizzle-orm";
import {
  foreignKey,
  index,
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
  ]
);

export const siteTasksRelations = relations(siteTasks, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [siteTasks.workspaceId],
    references: [workspaces.id],
  }),
}));
