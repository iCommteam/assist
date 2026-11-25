import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { and, desc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { db, siteChats } from "@db";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import type { AccessScope } from "@shared/identity/access-scope";

// The site's token for its own tools lives only here, encrypted for its chat,
// and for at most the 15 minutes the site gives a token: a token that has run
// out reads as none, so the chat has no Accounting tools until the site sends
// a fresh one.
const siteChatTokenLifetimeMs = 15 * 60_000;
const tokenKeyLabel = "icommassist/site-chat-token/v1";
const tokenPrefix = "v1.";
const ivBytes = 12;
const tagBytes = 16;

// Every query names the site, the workspace and the site's person, so a chat
// of another person, another site or a previous owner reads as unknown.
function chatOf(
  site: string,
  scope: AccessScope,
  siteUser: string,
  chatId: string
) {
  return and(
    eq(siteChats.id, chatId),
    eq(siteChats.site, site),
    eq(siteChats.workspaceId, scope.workspaceId),
    eq(siteChats.siteUser, siteUser)
  );
}

export async function recordSiteChat(
  site: string,
  scope: AccessScope,
  chat: {
    readonly id: string;
    readonly sessionId: string;
    readonly siteUser: string;
    readonly title: string | undefined;
    readonly topic: string | undefined;
  }
) {
  await db.insert(siteChats).values({
    id: chat.id,
    sessionId: chat.sessionId,
    site,
    siteUser: chat.siteUser,
    title: chat.title ?? null,
    topic: chat.topic ?? null,
    workspaceId: scope.workspaceId,
  });
}

// One chat of this site's person, or undefined.
export async function findSiteChat(
  site: string,
  scope: AccessScope,
  siteUser: string,
  chatId: string
) {
  const [chat] = await db
    .select({ createdAt: siteChats.createdAt, sessionId: siteChats.sessionId })
    .from(siteChats)
    .where(chatOf(site, scope, siteUser, chatId))
    .limit(1);
  return chat;
}

// The person's chats with this site, newest first, only those of one topic
// when it is given. Never their tokens.
export async function listSiteChats(
  site: string,
  scope: AccessScope,
  siteUser: string,
  topic: string | undefined,
  limit: number
) {
  return db
    .select({
      chatId: siteChats.id,
      createdAt: siteChats.createdAt,
      title: siteChats.title,
      topic: siteChats.topic,
    })
    .from(siteChats)
    .where(
      and(
        eq(siteChats.site, site),
        eq(siteChats.workspaceId, scope.workspaceId),
        eq(siteChats.siteUser, siteUser),
        topic === undefined ? undefined : eq(siteChats.topic, topic)
      )
    )
    .orderBy(desc(siteChats.createdAt), desc(siteChats.id))
    .limit(limit);
}

// Whether a session is the session of this chat of this site's person.
export async function isSiteChatSession(
  site: string,
  scope: AccessScope,
  siteUser: string,
  chatId: string,
  sessionId: string
) {
  const [chat] = await db
    .select({ id: siteChats.id })
    .from(siteChats)
    .where(
      and(
        chatOf(site, scope, siteUser, chatId),
        eq(siteChats.sessionId, sessionId)
      )
    )
    .limit(1);
  return chat !== undefined;
}

// Whether any site chat, in any workspace, has this session. The owner's own
// sign-in is refused on every such session.
export async function isAnySiteChatSession(sessionId: string) {
  const [chat] = await db
    .select({ id: siteChats.id })
    .from(siteChats)
    .where(eq(siteChats.sessionId, sessionId))
    .limit(1);
  return chat !== undefined;
}

// Replaces the chat's token with this one, and says whether the chat exists.
export async function storeSiteChatToken(
  site: string,
  scope: AccessScope,
  siteUser: string,
  chatId: string,
  token: string
) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  const rows = await db
    .update(siteChats)
    .set({
      teemiqToken: sealToken(secretEncryptionKey, scope, chatId, token),
      teemiqTokenExpiresAt: new Date(Date.now() + siteChatTokenLifetimeMs),
    })
    .where(chatOf(site, scope, siteUser, chatId))
    .returning({ id: siteChats.id });
  return rows.length > 0;
}

// The chat's token while it has not run out, by the database's clock, for
// the session of that chat alone; undefined otherwise or when it cannot be
// opened.
export async function readSiteChatToken(
  scope: AccessScope,
  chatId: string,
  sessionId: string
) {
  const [chat] = await db
    .select({
      expiresAt: siteChats.teemiqTokenExpiresAt,
      sealed: siteChats.teemiqToken,
    })
    .from(siteChats)
    .where(
      and(
        eq(siteChats.id, chatId),
        eq(siteChats.workspaceId, scope.workspaceId),
        eq(siteChats.sessionId, sessionId),
        isNotNull(siteChats.teemiqToken),
        gt(siteChats.teemiqTokenExpiresAt, sql`now()`)
      )
    )
    .limit(1);
  if (!chat?.sealed || !chat.expiresAt) return undefined;
  const { secretEncryptionKey } = await getInstallationSecrets();
  const token = openToken(secretEncryptionKey, scope, chatId, chat.sealed);
  return token === undefined
    ? undefined
    : { expiresAt: chat.expiresAt.getTime(), token };
}

// Forgets the token of a chat's session. At the end of a turn, only one that
// arrived by `arrivedBy`, when the turn took its last message: one that
// arrived later came with a message the turn never took, and stays for that
// message's turn. At the end of the session, any. One update decides it, so a
// token stored meanwhile is never cleared by a stale read.
export async function clearSiteChatToken(sessionId: string, arrivedBy?: Date) {
  await db
    .update(siteChats)
    .set({ teemiqToken: null, teemiqTokenExpiresAt: null })
    .where(
      and(
        eq(siteChats.sessionId, sessionId),
        isNotNull(siteChats.teemiqToken),
        // A token runs out its lifetime after it arrived.
        arrivedBy === undefined
          ? undefined
          : lte(
              siteChats.teemiqTokenExpiresAt,
              new Date(arrivedBy.getTime() + siteChatTokenLifetimeMs)
            )
      )
    );
}

// AES-256-GCM under a key derived for chat tokens alone, bound to the
// workspace and the chat, so a sealed token copied to another row never opens.
function sealToken(
  secretEncryptionKey: string,
  scope: AccessScope,
  chatId: string,
  token: string
) {
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv(
    "aes-256-gcm",
    tokenKey(secretEncryptionKey),
    iv,
    {
      authTagLength: tagBytes,
    }
  );
  cipher.setAAD(tokenAad(scope, chatId));
  const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${tokenPrefix}${Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url")}`;
}

function openToken(
  secretEncryptionKey: string,
  scope: AccessScope,
  chatId: string,
  value: string
) {
  if (!value.startsWith(tokenPrefix)) return undefined;
  const bytes = Buffer.from(value.slice(tokenPrefix.length), "base64url");
  if (bytes.length <= ivBytes + tagBytes) return undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      tokenKey(secretEncryptionKey),
      bytes.subarray(0, ivBytes),
      { authTagLength: tagBytes }
    );
    decipher.setAAD(tokenAad(scope, chatId));
    decipher.setAuthTag(bytes.subarray(bytes.length - tagBytes));
    return Buffer.concat([
      decipher.update(bytes.subarray(ivBytes, bytes.length - tagBytes)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
}

function tokenKey(secretEncryptionKey: string) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secretEncryptionKey, "base64"),
      "",
      tokenKeyLabel,
      32
    )
  );
}

function tokenAad(scope: AccessScope, chatId: string) {
  return Buffer.from(
    `${scope.workspaceId}\u0000site-chat-token\u0000${chatId}`
  );
}
