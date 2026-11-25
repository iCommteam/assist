import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import { ensureScope } from "@db/services/scope";
import {
  admitWhatsappMessage,
  claimWhatsappBrowserTask,
  claimWhatsappChatAnnouncement,
  claimWhatsappMessage,
  countWhatsappMessage,
  dropHeldWhatsappReply,
  endWhatsappChat,
  heldWhatsappReplies,
  holdWhatsappReply,
  lockWhatsapp,
  openWhatsappChats,
  recordWhatsappChat,
  unlockWhatsapp,
  whatsappChatOfSession,
  whatsappEveryone,
  whatsappLockOf,
  whatsappWrittenWithin,
} from "@db/services/whatsapp";
import { accessScopeForUser } from "@shared/identity/access-scope";

const client = new PGlite();
const database = drizzle(client, { schema });
const member = accessScopeForUser("better-auth:user-1");
const phone = "+15550000001";
const caps = [
  { max: 3, ms: 60 * 60_000 },
  { max: 5, ms: 24 * 60 * 60_000 },
];

let sequence = 0;
function nextSid() {
  sequence += 1;
  return `SM${String(sequence).padStart(32, "0")}`;
}

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
  await ensureScope(member);
}, 20_000);

beforeEach(async () => {
  await client.exec(
    "TRUNCATE whatsapp_messages, whatsapp_locks, whatsapp_chats, whatsapp_held_replies, whatsapp_browser_tasks CASCADE"
  );
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("WhatsApp messages", () => {
  it("claims each message id once", async () => {
    const sid = nextSid();
    await expect(claimWhatsappMessage(sid, phone)).resolves.toBe(true);
    await expect(claimWhatsappMessage(sid, phone)).resolves.toBe(false);
  });

  it("forgets messages older than two days as new ones arrive", async () => {
    const old = nextSid();
    await claimWhatsappMessage(old, phone);
    await client.query(
      "UPDATE whatsapp_messages SET received_at = now() - interval '49 hours' WHERE sid = $1",
      [old]
    );
    await claimWhatsappMessage(nextSid(), phone);
    const rows = await client.query(
      "SELECT sid FROM whatsapp_messages WHERE sid = $1",
      [old]
    );
    expect(rows.rows).toEqual([]);
  });

  it("counts a number's messages against each cap, and never past one, even when they arrive together", async () => {
    const sids = Array.from({ length: 6 }, nextSid);
    await Promise.all(sids.map((sid) => claimWhatsappMessage(sid, phone)));

    const counted = await Promise.all(
      sids.map((sid) => countWhatsappMessage(sid, phone, caps))
    );

    expect(counted.filter(Boolean)).toHaveLength(3);
    // Another number has its own caps.
    const other = nextSid();
    await claimWhatsappMessage(other, "+15550000002");
    await expect(
      countWhatsappMessage(other, "+15550000002", caps)
    ).resolves.toBe(true);
  });

  it("reopens the hourly cap after an hour, until the day's is full", async () => {
    for (let hour = 0; hour < 3; hour += 1) {
      for (let sent = 0; sent < 3; sent += 1) {
        const sid = nextSid();
        // oxlint-disable-next-line eslint/no-await-in-loop -- Messages arrive one after another.
        await claimWhatsappMessage(sid, phone);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Messages arrive one after another.
        await countWhatsappMessage(sid, phone, caps);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- An hour passes.
      await client.exec(
        "UPDATE whatsapp_messages SET received_at = received_at - interval '61 minutes'"
      );
    }
    const rows = await client.query<{ counted: number }>(
      "SELECT count(*)::int AS counted FROM whatsapp_messages WHERE counted"
    );
    expect(rows.rows[0]?.counted).toBe(5);
  });

  it("opens the 24-hour window only with a message that passed the checks", async () => {
    const dropped = nextSid();
    await claimWhatsappMessage(dropped, phone);
    await expect(whatsappWrittenWithin(phone, 60_000)).resolves.toBe(false);

    const admitted = nextSid();
    await claimWhatsappMessage(admitted, phone);
    await admitWhatsappMessage(admitted);
    await expect(whatsappWrittenWithin(phone, 60_000)).resolves.toBe(true);

    await client.exec(
      "UPDATE whatsapp_messages SET received_at = now() - interval '2 minutes'"
    );
    await expect(whatsappWrittenWithin(phone, 60_000)).resolves.toBe(false);
    await expect(whatsappWrittenWithin("+15550000002", 60_000)).resolves.toBe(
      false
    );
  });
});

describe("WhatsApp locks", () => {
  it("locks a member, or everyone, and only the matching unlock lifts it", async () => {
    await expect(whatsappLockOf("user-1")).resolves.toEqual({
      everyone: false,
      self: false,
    });
    await lockWhatsapp("user-1", "whatsapp");
    await lockWhatsapp("user-1", "web");
    await expect(whatsappLockOf("user-1")).resolves.toEqual({
      everyone: false,
      self: true,
    });
    await expect(whatsappLockOf("user-2")).resolves.toEqual({
      everyone: false,
      self: false,
    });

    await lockWhatsapp(whatsappEveryone, "admin");
    await unlockWhatsapp("user-1");
    await expect(whatsappLockOf("user-1")).resolves.toEqual({
      everyone: true,
      self: false,
    });
    await unlockWhatsapp(whatsappEveryone);
    await expect(whatsappLockOf("user-2")).resolves.toEqual({
      everyone: false,
      self: false,
    });
  });
});

describe("WhatsApp chats", () => {
  const chat = (sessionId: string, messageSid = nextSid()) => ({
    email: "member@example.test",
    messageAt: new Date(),
    messageSid,
    phone,
    sessionId,
    userId: member.userId,
    workspaceId: member.workspaceId,
  });

  it("records a chat once per session, keeps its latest message, and announces it once", async () => {
    const first = await recordWhatsappChat(chat("session-a"));
    const latest = nextSid();
    const again = await recordWhatsappChat(chat("session-a", latest));

    expect(again.id).toBe(first.id);
    expect(first.announcedAt).toBeNull();
    await expect(whatsappChatOfSession("session-a")).resolves.toMatchObject({
      email: "member@example.test",
      endedAt: null,
      lastSid: latest,
      phone,
      userId: member.userId,
    });
    await expect(claimWhatsappChatAnnouncement(first.id)).resolves.toBe(true);
    await expect(claimWhatsappChatAnnouncement(first.id)).resolves.toBe(false);
  });

  it("lists a member's open chats, or everyone's, and ends one", async () => {
    await recordWhatsappChat(chat("session-a"));
    await recordWhatsappChat(chat("session-b"));
    await endWhatsappChat("session-a");

    await expect(openWhatsappChats(member.userId)).resolves.toMatchObject([
      { sessionId: "session-b" },
    ]);
    await expect(openWhatsappChats("better-auth:user-2")).resolves.toEqual([]);
    await expect(openWhatsappChats()).resolves.toHaveLength(1);
    expect((await whatsappChatOfSession("session-a"))?.endedAt).toBeInstanceOf(
      Date
    );
    await expect(whatsappChatOfSession("session-c")).resolves.toBeUndefined();
  });
});

describe("held WhatsApp replies", () => {
  it("keeps a member's held replies in order, for their number only, for seven days", async () => {
    await holdWhatsappReply({
      content: { body: "First." },
      level: "full",
      phone,
      userId: member.userId,
    });
    await holdWhatsappReply({
      content: { mediaUrl: "https://files.example/a.pdf" },
      level: "narrow",
      phone,
      userId: member.userId,
    });
    await holdWhatsappReply({
      content: { body: "Another number's." },
      level: "full",
      phone: "+15550000002",
      userId: member.userId,
    });

    const held = await heldWhatsappReplies(member.userId, phone);
    expect(
      held.map(({ body, level, mediaUrl }) => ({ body, level, mediaUrl }))
    ).toEqual([
      { body: "First.", level: "full", mediaUrl: null },
      { body: null, level: "narrow", mediaUrl: "https://files.example/a.pdf" },
    ]);

    await dropHeldWhatsappReply(held[0]?.id ?? 0);
    await client.exec(
      "UPDATE whatsapp_held_replies SET created_at = now() - interval '8 days'"
    );
    await expect(heldWhatsappReplies(member.userId, phone)).resolves.toEqual(
      []
    );
  });
});

describe("WhatsApp browser workers", () => {
  it("counts a member's workers for 24 hours, the same task once", async () => {
    for (let task = 1; task <= 2; task += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Workers start one after another.
      await expect(
        claimWhatsappBrowserTask(`task-${String(task)}`, member.userId, 2)
      ).resolves.toBe(true);
    }
    await expect(
      claimWhatsappBrowserTask("task-1", member.userId, 2)
    ).resolves.toBe(true);
    await expect(
      claimWhatsappBrowserTask("task-3", member.userId, 2)
    ).resolves.toBe(false);
    await expect(
      claimWhatsappBrowserTask("task-4", "better-auth:user-2", 2)
    ).resolves.toBe(true);

    await client.exec(
      "UPDATE whatsapp_browser_tasks SET started_at = now() - interval '25 hours'"
    );
    await expect(
      claimWhatsappBrowserTask("task-5", member.userId, 2)
    ).resolves.toBe(true);
  });
});
