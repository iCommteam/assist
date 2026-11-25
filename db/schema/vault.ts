import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { vaultItemKinds } from "@shared/vault/schema";
import { workspaces } from "./workspaces";

export const vaultItems = pgTable(
  "vault_items",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind", { enum: vaultItemKinds }).notNull(),
    label: text("label").notNull(),
    account: text("account").notNull(),
    // The connected site that saved this login through the site API, or null
    // for an item the owner saved in iCommAssist. A site sees only its own.
    site: text("site"),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "vault_items_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "vault_items_kind_check",
      sql`${table.kind} IN ('login', 'payment', 'address', 'contact', 'phone', 'identity', 'token')`
    ),
    index("vault_items_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt.desc().nullsFirst()
    ),
    index("vault_items_workspace_site_idx").on(
      table.workspaceId,
      table.site,
      table.createdAt.desc()
    ),
  ]
);

// Each namespace seals its values under its own key: the vault's saved
// secrets, and a member's connected accounts, such as Google
// (db/services/connectors/google.ts).
export const encryptedSecrets = pgTable(
  "encrypted_secrets",
  {
    workspaceId: text("workspace_id").notNull(),
    namespace: text("namespace", { enum: ["vault", "connector"] }).notNull(),
    id: text("id").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.namespace, table.id],
      name: "encrypted_secrets_pkey",
    }),
    foreignKey({
      name: "encrypted_secrets_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "encrypted_secrets_namespace_check",
      sql`${table.namespace} IN ('vault', 'connector')`
    ),
  ]
);

export const vaultItemsRelations = relations(vaultItems, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [vaultItems.workspaceId],
    references: [workspaces.id],
  }),
}));

export const encryptedSecretsRelations = relations(
  encryptedSecrets,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [encryptedSecrets.workspaceId],
      references: [workspaces.id],
    }),
  })
);
