import { ClientError, SessionNotActiveError } from "eve/client";
import type { ReceivedEvent } from "eve/events";
import { z } from "zod";
import { findSiteChat, storeSiteChatToken } from "@db/services/site-chats";
import type { AccessScope } from "@shared/identity/access-scope";
import { siteError } from "@app/api/site/_lib/site-auth";
import { siteEveClient } from "@app/api/site/_lib/eve";

// The site's token for its own tools, as the site minted it; assist never
// reads inside it.
export const teemiqTokenSchema = z
  .string()
  .min(16)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/u);

export interface SiteChat {
  readonly chatId: string;
  readonly createdAt: Date;
  readonly sessionId: string;
  readonly siteUser: string;
}

// One of this site's chats with this person. Anything else, another person's
// chat included, reads as not found.
export async function lookupSiteChat(
  site: string,
  scope: AccessScope,
  siteUser: string,
  chatId: string
) {
  let chat: Awaited<ReturnType<typeof findSiteChat>>;
  try {
    chat = z.uuid().safeParse(chatId).success
      ? await findSiteChat(site, scope, siteUser, chatId)
      : undefined;
  } catch (error) {
    console.warn("[site] chat lookup failed", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return { ok: false as const, response: siteError(503, "unavailable") };
  }
  if (!chat) {
    return { ok: false as const, response: siteError(404, "not_found") };
  }
  return {
    chat: { ...chat, chatId, siteUser } satisfies SiteChat,
    ok: true as const,
  };
}

// Replaces the chat's token before the call that needs it.
export async function keepSiteChatToken(
  site: string,
  scope: AccessScope,
  chat: SiteChat,
  token: string
) {
  try {
    await storeSiteChatToken(site, scope, chat.siteUser, chat.chatId, token);
    return { ok: true as const };
  } catch (error) {
    console.warn("[site] chat token could not be stored", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return { ok: false as const, response: siteError(503, "unavailable") };
  }
}

export function chatGrant(site: string, chat: SiteChat) {
  return { chat: chat.chatId, site, siteUser: chat.siteUser };
}

// Every event of the chat's session so far.
export async function readSiteChatEvents(site: string, chat: SiteChat) {
  const read = await callChatEve(site, async () => {
    const events: ReceivedEvent[] = [];
    const stream = siteEveClient({
      ...chatGrant(site, chat),
      op: "chat.read",
      session: chat.sessionId,
    })
      .sessions.attach(chat.sessionId)
      .stream({
        follow: false,
        reconnect: { maxAttempts: 2 },
        signal: AbortSignal.timeout(20_000),
      });
    for await (const event of stream) events.push(event);
    return events;
  });
  return read.ok ? { events: read.value, ok: true as const } : read;
}

// Runs one call to eve for a chat. A chat whose session has ended takes
// nothing more, so the site opens a new chat; while a question is answered or
// the session is still starting, the call conflicts; anything else eve
// refuses is transient.
export async function callChatEve<T>(site: string, call: () => Promise<T>) {
  try {
    return { ok: true as const, value: await call() };
  } catch (error) {
    if (
      (SessionNotActiveError.is(error) && !error.retryable) ||
      (ClientError.is(error) && error.code === "session_expired")
    ) {
      return { ok: false as const, response: siteError(410, "chat_ended") };
    }
    if (
      (ClientError.is(error) && error.status === 409) ||
      SessionNotActiveError.is(error)
    ) {
      return { ok: false as const, response: siteError(409, "not_ready") };
    }
    console.warn("[site] chat call to the agent runtime failed", {
      error: ClientError.is(error) ? error.code : "unknown",
      site,
    });
    return { ok: false as const, response: siteError(503, "unavailable") };
  }
}

// Each turn spends model time, so a site's person is capped: 30 turns in any
// hour and 200 in any day, results the site posts included. The service runs
// one replica, so memory holds the whole count; a restart forgets it.
const turnWindows = [
  { max: 30, ms: 60 * 60_000 },
  { max: 200, ms: 24 * 60 * 60_000 },
] as const;
const recentTurns = new Map<string, number[]>();

// Synchronous, so concurrent requests cannot all take the last slot.
export function claimChatTurn(site: string, siteUser: string) {
  return claimSlot(recentTurns, `${site}\0${siteUser}`, turnWindows);
}

// Opening a chat costs no model time, but each holds a session, so a
// person may open 30 in any hour.
const chatWindows = [{ max: 30, ms: 60 * 60_000 }] as const;
const recentChats = new Map<string, number[]>();

export function claimChatStart(site: string, siteUser: string) {
  return claimSlot(recentChats, `${site}\0${siteUser}`, chatWindows);
}

function claimSlot(
  recent: Map<string, number[]>,
  key: string,
  windows: readonly { readonly max: number; readonly ms: number }[]
) {
  const now = Date.now();
  const longest = Math.max(...windows.map(({ ms }) => ms));
  const times = (recent.get(key) ?? []).filter((at) => at > now - longest);
  recent.set(key, times);
  for (const { max, ms } of windows) {
    const inWindow = times.filter((at) => at > now - ms);
    if (inWindow.length >= max) {
      const reopensAt = Math.min(...inWindow) + ms;
      return {
        ok: false as const,
        retryAfterSeconds: Math.max(1, Math.ceil((reopensAt - now) / 1000)),
      };
    }
  }
  times.push(now);
  return { ok: true as const };
}
