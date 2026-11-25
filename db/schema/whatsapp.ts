import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

function at(name: string) {
  return timestamp(name, { mode: "date", precision: 3, withTimezone: true });
}

// Every WhatsApp message a listed member who can sign in sent, by Twilio's
// message id: the dedupe, the caps and the 24-hour window, so each survives
// a restart. `admitted` marks a message that passed Twilio's record check,
// or that a locked member's narrow chat took as it came; only those open the
// window. `counted` marks one that counts against the caps. Rows older than
// two days are deleted as new ones arrive.
export const whatsappMessages = pgTable(
  "whatsapp_messages",
  {
    sid: text("sid").primaryKey(),
    phone: text("phone").notNull(),
    receivedAt: at("received_at").defaultNow().notNull(),
    admitted: boolean("admitted").default(false).notNull(),
    counted: boolean("counted").default(false).notNull(),
  },
  (table) => [
    index("whatsapp_messages_phone_idx").on(
      table.phone,
      table.receivedAt.desc()
    ),
    index("whatsapp_messages_received_idx").on(table.receivedAt),
  ]
);

// Who has turned WhatsApp's full access and Accounting off: a member's
// Better Auth user id, or `*` for everyone, which only an administrator
// sets and lifts. A row means locked.
export const whatsappLocks = pgTable(
  "whatsapp_locks",
  {
    member: text("member").primaryKey(),
    lockedBy: text("locked_by", {
      enum: ["admin", "web", "whatsapp"],
    }).notNull(),
    lockedAt: at("locked_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "whatsapp_locks_locked_by_check",
      sql`${table.lockedBy} IN ('admin', 'web', 'whatsapp')`
    ),
  ]
);

// The full-access WhatsApp chats, one per agent session: who and which
// number it is for, the id of the member's last message that passed Twilio's
// record check, and the Accounting state. The token TEEMIQ minted for the
// chat is encrypted for it, as a site chat's is, and never leaves this row.
export const whatsappChats = pgTable(
  "whatsapp_chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull().unique(),
    workspaceId: text("workspace_id").notNull(),
    // The member's principal id, `better-auth:<user id>`.
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    lastSid: text("last_sid"),
    lastSidAt: at("last_sid_at"),
    // When the channel sent the chat's fixed line on what is on.
    announcedAt: at("announced_at"),
    teemiqToken: text("teemiq_token"),
    teemiqTokenExpiresAt: at("teemiq_token_expires_at"),
    // The TEEMIQ user the chat's last vouch named.
    teemiqUser: text("teemiq_user"),
    // TEEMIQ's refusal code for the last vouch, and the message id it was
    // for, so the same message is never offered again.
    vouchRefusal: text("vouch_refusal"),
    vouchRefusedSid: text("vouch_refused_sid"),
    createdAt: at("created_at").defaultNow().notNull(),
    endedAt: at("ended_at"),
  },
  (table) => [
    foreignKey({
      name: "whatsapp_chats_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "whatsapp_chats_teemiq_token_check",
      sql`(${table.teemiqToken} IS NULL) = (${table.teemiqTokenExpiresAt} IS NULL)`
    ),
    index("whatsapp_chats_member_idx").on(
      table.userId,
      table.phone,
      table.createdAt.desc()
    ),
  ]
);

// The looks and fetches a WhatsApp chat's Accounting started, by TEEMIQ's
// fetch id, and the status TEEMIQ posted once each one ended.
export const whatsappChatFetches = pgTable(
  "whatsapp_chat_fetches",
  {
    chatId: uuid("chat_id").notNull(),
    fetchId: text("fetch_id").notNull(),
    recordedAt: at("recorded_at").defaultNow().notNull(),
    status: text("status", { enum: ["done", "failed"] }),
    statusAt: at("status_at"),
    // When the agent learnt the status: a result frame in its session, or a
    // later turn's context.
    seenAt: at("seen_at"),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.fetchId] }),
    foreignKey({
      name: "whatsapp_chat_fetches_chat_id_fkey",
      columns: [table.chatId],
      foreignColumns: [whatsappChats.id],
    }).onDelete("cascade"),
    check(
      "whatsapp_chat_fetches_status_check",
      sql`(${table.status} IS NULL OR ${table.status} IN ('done', 'failed')) AND (${table.status} IS NULL) = (${table.statusAt} IS NULL)`
    ),
  ]
);

// Replies that came while the member's 24-hour window was shut, sent first,
// in order, when the same member next writes from the same number. A full
// chat's reply goes only while full access is still on.
export const whatsappHeldReplies = pgTable(
  "whatsapp_held_replies",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    phone: text("phone").notNull(),
    userId: text("user_id").notNull(),
    level: text("level", { enum: ["full", "narrow"] }).notNull(),
    body: text("body"),
    mediaUrl: text("media_url"),
    createdAt: at("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "whatsapp_held_replies_level_check",
      sql`${table.level} IN ('full', 'narrow')`
    ),
    check(
      "whatsapp_held_replies_content_check",
      sql`(${table.body} IS NULL) <> (${table.mediaUrl} IS NULL)`
    ),
    index("whatsapp_held_replies_member_idx").on(
      table.userId,
      table.phone,
      table.id
    ),
  ]
);

// The browser workers a member's full WhatsApp chats started, by the
// eve task of each, for the cap of 10 a day.
export const whatsappBrowserTasks = pgTable(
  "whatsapp_browser_tasks",
  {
    taskId: text("task_id").primaryKey(),
    userId: text("user_id").notNull(),
    startedAt: at("started_at").defaultNow().notNull(),
  },
  (table) => [
    index("whatsapp_browser_tasks_user_idx").on(
      table.userId,
      table.startedAt.desc()
    ),
  ]
);

export const whatsappChatsRelations = relations(
  whatsappChats,
  ({ many, one }) => ({
    fetches: many(whatsappChatFetches),
    workspace: one(workspaces, {
      fields: [whatsappChats.workspaceId],
      references: [workspaces.id],
    }),
  })
);

export const whatsappChatFetchesRelations = relations(
  whatsappChatFetches,
  ({ one }) => ({
    chat: one(whatsappChats, {
      fields: [whatsappChatFetches.chatId],
      references: [whatsappChats.id],
    }),
  })
);
