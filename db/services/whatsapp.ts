import { and, asc, count, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  whatsappBrowserTasks,
  whatsappChats,
  whatsappHeldReplies,
  whatsappLocks,
  whatsappMessages,
} from "@db";

// The WhatsApp channel's durable state (db/schema/whatsapp.ts). Nothing here
// logs a value: numbers and message ids stay in their rows.

const messageRetention = sql`interval '2 days'`;
const heldReplyRetention = sql`interval '7 days'`;
const everyone = "*";

// --- Messages: dedupe, caps and the window ---------------------------------

// Records a message the first time its id arrives, and says whether this is
// that first time; Twilio may post one message twice. Rows past their two
// days go as new ones arrive.
export async function claimWhatsappMessage(sid: string, phone: string) {
  const rows = await db
    .insert(whatsappMessages)
    .values({ phone, sid })
    .onConflictDoNothing()
    .returning({ sid: whatsappMessages.sid });
  await db
    .delete(whatsappMessages)
    .where(lt(whatsappMessages.receivedAt, sql`now() - ${messageRetention}`));
  return rows.length > 0;
}

// Marks a message as one the member really sent: it passed Twilio's record
// check, or a locked member's narrow chat took it as it came. Only these open
// the 24-hour window.
export async function admitWhatsappMessage(sid: string) {
  await db
    .update(whatsappMessages)
    .set({ admitted: true })
    .where(eq(whatsappMessages.sid, sid));
}

// Counts the message against its number's caps, unless one of them is full,
// and says whether it did. One number's counts are taken one at a time, so
// concurrent messages cannot all take the last slot.
export async function countWhatsappMessage(
  sid: string,
  phone: string,
  windows: readonly { readonly max: number; readonly ms: number }[]
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`whatsapp-caps:${phone}`}))`
    );
    for (const window of windows) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each window is its own count, inside the one lock.
      const [counted] = await tx
        .select({ value: count() })
        .from(whatsappMessages)
        .where(
          and(
            eq(whatsappMessages.phone, phone),
            eq(whatsappMessages.counted, true),
            gt(
              whatsappMessages.receivedAt,
              sql`now() - make_interval(secs => ${window.ms / 1000})`
            )
          )
        );
      if ((counted?.value ?? 0) >= window.max) return false;
    }
    const rows = await tx
      .update(whatsappMessages)
      .set({ counted: true })
      .where(eq(whatsappMessages.sid, sid))
      .returning({ sid: whatsappMessages.sid });
    return rows.length > 0;
  });
}

// Whether the member wrote from this number, by a message that passed the
// checks, within the last `withinMs`, by the database's clock.
export async function whatsappWrittenWithin(phone: string, withinMs: number) {
  const [row] = await db
    .select({ sid: whatsappMessages.sid })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.phone, phone),
        eq(whatsappMessages.admitted, true),
        gt(
          whatsappMessages.receivedAt,
          sql`now() - make_interval(secs => ${withinMs / 1000})`
        )
      )
    )
    .limit(1);
  return row !== undefined;
}

// --- The lock ---------------------------------------------------------------

// Whether the member turned WhatsApp's full access off, and whether an
// administrator turned it off for everyone. `userId` is the Better Auth user
// id, without the principal prefix.
export async function whatsappLockOf(userId: string) {
  const rows = await db
    .select({ member: whatsappLocks.member })
    .from(whatsappLocks)
    .where(inArray(whatsappLocks.member, [userId, everyone]));
  const members = new Set(rows.map(({ member }) => member));
  return { everyone: members.has(everyone), self: members.has(userId) };
}

// `member` is a Better Auth user id, or whatsappEveryone.
export async function lockWhatsapp(
  member: string,
  lockedBy: "admin" | "web" | "whatsapp"
) {
  await db
    .insert(whatsappLocks)
    .values({ lockedBy, member })
    .onConflictDoNothing();
}

export async function unlockWhatsapp(member: string) {
  await db.delete(whatsappLocks).where(eq(whatsappLocks.member, member));
}

export const whatsappEveryone = everyone;

// --- Chats ------------------------------------------------------------------

// Records the full-access chat a message reached, or its next message: the
// id of that message, which passed Twilio's record check, and when it
// arrived. Returns the chat's id and whether its fixed line still has to be
// sent.
export async function recordWhatsappChat(chat: {
  readonly email: string;
  readonly messageAt: Date;
  readonly messageSid: string;
  readonly phone: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceId: string;
}) {
  const [row] = await db
    .insert(whatsappChats)
    .values({
      email: chat.email,
      lastSid: chat.messageSid,
      lastSidAt: chat.messageAt,
      phone: chat.phone,
      sessionId: chat.sessionId,
      userId: chat.userId,
      workspaceId: chat.workspaceId,
    })
    .onConflictDoUpdate({
      set: { lastSid: chat.messageSid, lastSidAt: chat.messageAt },
      target: whatsappChats.sessionId,
    })
    .returning({
      announcedAt: whatsappChats.announcedAt,
      id: whatsappChats.id,
    });
  if (!row) throw new Error("The WhatsApp chat could not be recorded.");
  return row;
}

// Claims the chat's one fixed line: true only the first time.
export async function claimWhatsappChatAnnouncement(chatId: string) {
  const rows = await db
    .update(whatsappChats)
    .set({ announcedAt: sql`now()` })
    .where(and(eq(whatsappChats.id, chatId), isNull(whatsappChats.announcedAt)))
    .returning({ id: whatsappChats.id });
  return rows.length > 0;
}

const chatColumns = {
  email: whatsappChats.email,
  endedAt: whatsappChats.endedAt,
  id: whatsappChats.id,
  lastSid: whatsappChats.lastSid,
  lastSidAt: whatsappChats.lastSidAt,
  phone: whatsappChats.phone,
  sessionId: whatsappChats.sessionId,
  userId: whatsappChats.userId,
  workspaceId: whatsappChats.workspaceId,
};

// The full-access chat a session is; undefined for every other session.
export async function whatsappChatOfSession(sessionId: string) {
  const [chat] = await db
    .select(chatColumns)
    .from(whatsappChats)
    .where(eq(whatsappChats.sessionId, sessionId))
    .limit(1);
  return chat;
}

// A member's chats that have not ended, or everyone's, for a lock to end; or
// those on one of the member's numbers, for a number that stops reaching
// them.
export async function openWhatsappChats(userId?: string, phone?: string) {
  return db
    .select(chatColumns)
    .from(whatsappChats)
    .where(
      and(
        isNull(whatsappChats.endedAt),
        userId === undefined ? undefined : eq(whatsappChats.userId, userId),
        phone === undefined ? undefined : eq(whatsappChats.phone, phone)
      )
    );
}

// The chat ended.
export async function endWhatsappChat(sessionId: string) {
  await db
    .update(whatsappChats)
    .set({ endedAt: sql`coalesce(${whatsappChats.endedAt}, now())` })
    .where(eq(whatsappChats.sessionId, sessionId));
}

// --- Held replies -----------------------------------------------------------

export async function holdWhatsappReply(reply: {
  readonly content: { readonly body: string } | { readonly mediaUrl: string };
  readonly level: "full" | "narrow";
  readonly phone: string;
  readonly userId: string;
}) {
  await db.insert(whatsappHeldReplies).values({
    body: "body" in reply.content ? reply.content.body : null,
    level: reply.level,
    mediaUrl: "mediaUrl" in reply.content ? reply.content.mediaUrl : null,
    phone: reply.phone,
    userId: reply.userId,
  });
}

// The replies held for this member on this number, oldest first, within
// their seven days; older ones are dropped.
export async function heldWhatsappReplies(userId: string, phone: string) {
  await db
    .delete(whatsappHeldReplies)
    .where(
      lt(whatsappHeldReplies.createdAt, sql`now() - ${heldReplyRetention}`)
    );
  return db
    .select({
      body: whatsappHeldReplies.body,
      id: whatsappHeldReplies.id,
      level: whatsappHeldReplies.level,
      mediaUrl: whatsappHeldReplies.mediaUrl,
    })
    .from(whatsappHeldReplies)
    .where(
      and(
        eq(whatsappHeldReplies.userId, userId),
        eq(whatsappHeldReplies.phone, phone)
      )
    )
    .orderBy(asc(whatsappHeldReplies.id));
}

export async function dropHeldWhatsappReply(id: number) {
  await db.delete(whatsappHeldReplies).where(eq(whatsappHeldReplies.id, id));
}

// --- Browser workers --------------------------------------------------------

// Records a browser worker a member's full WhatsApp chat starts, by its eve
// task, unless the member already started `limit` in the last 24 hours; the
// same task again is the same worker.
export async function claimWhatsappBrowserTask(
  taskId: string,
  userId: string,
  limit: number
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`whatsapp-browser:${userId}`}))`
    );
    const [known] = await tx
      .select({ taskId: whatsappBrowserTasks.taskId })
      .from(whatsappBrowserTasks)
      .where(eq(whatsappBrowserTasks.taskId, taskId))
      .limit(1);
    if (known) return true;
    const [started] = await tx
      .select({ value: count() })
      .from(whatsappBrowserTasks)
      .where(
        and(
          eq(whatsappBrowserTasks.userId, userId),
          gt(whatsappBrowserTasks.startedAt, sql`now() - interval '24 hours'`)
        )
      );
    if ((started?.value ?? 0) >= limit) return false;
    await tx.insert(whatsappBrowserTasks).values({ taskId, userId });
    return true;
  });
}
