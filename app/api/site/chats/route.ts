import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureScope } from "@db/services/scope";
import { claimSession } from "@db/services/sessions";
import { listSiteChats, recordSiteChat } from "@db/services/site-chats";
import type { AccessScope } from "@shared/identity/access-scope";
import { siteUserSchema } from "@shared/identity/site-credential";
import {
  authenticateSiteRequest,
  siteError,
  siteJson,
} from "@app/api/site/_lib/site-auth";
import { readSiteJsonBody } from "@app/api/site/_lib/request-body";
import { siteEveClient } from "@app/api/site/_lib/eve";
import { claimChatStart } from "@app/api/site/chats/_lib/chat";

const maxBodyBytes = 4 * 1024;
const maxListed = 50;
// An opaque key such as `txn:<uuid>`: printable, with no spaces.
const topicSchema = z.string().regex(/^[\x21-\x7e]{1,200}$/u);
const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((title) => !/[\p{Cc}\p{Cf}]/u.test(title));
const chatInputSchema = z.object({
  siteUser: siteUserSchema,
  title: titleSchema.optional(),
  topic: topicSchema.optional(),
});

// Opens a chat for one of the site's people, as an agent session with no
// turn yet.
export async function POST(request: Request) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const input = chatInputSchema.safeParse(
    await readSiteJsonBody(request, maxBodyBytes)
  );
  if (!input.success) return siteError(400, "invalid_request");
  const { owner, site } = caller;
  const start = claimChatStart(site, input.data.siteUser);
  if (!start.ok) {
    console.warn("[site] chat start rate limited", { site });
    return siteError(429, "rate_limited", {
      "retry-after": String(start.retryAfterSeconds),
    });
  }
  return openChat(owner.scope, site, input.data);
}

// A person's chats with this site, newest first, only one topic's when
// `topic` is given, at most 50.
export async function GET(request: Request) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const query = new URL(request.url).searchParams;
  const input = z
    .object({
      siteUser: siteUserSchema,
      topic: topicSchema.optional(),
    })
    .safeParse({
      siteUser: query.get("siteUser"),
      topic: query.get("topic") ?? undefined,
    });
  if (!input.success) return siteError(400, "invalid_request");
  const { owner, site } = caller;
  try {
    const chats = await listSiteChats(
      site,
      owner.scope,
      input.data.siteUser,
      input.data.topic,
      maxListed
    );
    return siteJson({
      chats: chats.map(({ chatId, createdAt, title, topic }) => ({
        chatId,
        createdAt: createdAt.toISOString(),
        title,
        topic,
      })),
    });
  } catch (error) {
    console.warn("[site] chats could not be listed", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
}

async function openChat(
  scope: AccessScope,
  site: string,
  input: z.infer<typeof chatInputSchema>
) {
  const chatId = randomUUID();
  try {
    // The chat row references the workspace, which the session hook would
    // otherwise create only after eve has accepted the session.
    await ensureScope(scope);
    const { session } = await siteEveClient({
      chat: chatId,
      op: "chat.create",
      site,
      siteUser: input.siteUser,
    }).sessions.create();
    // The session hook claims a session once it starts; claiming it here
    // too lets the chat's first message pass the ownership check at once.
    await claimSession(scope, session.id);
    await recordOpenedChat(() =>
      recordSiteChat(site, scope, {
        id: chatId,
        sessionId: session.id,
        siteUser: input.siteUser,
        title: input.title,
        topic: input.topic,
      })
    );
    return siteJson({ chatId }, 201);
  } catch (error) {
    console.warn("[site] chat could not open", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
}

// eve has already created the session, so a short retry covers a passing
// database error; an unrecorded session holds no turn and nobody reaches it.
const recordAttempts = 3;
const recordRetryDelayMs = 250;

async function recordOpenedChat(
  record: () => Promise<void>,
  attempt = 1
): Promise<void> {
  try {
    await record();
  } catch (error) {
    if (attempt >= recordAttempts) throw error;
    await new Promise((resolve) => setTimeout(resolve, recordRetryDelayMs));
    await recordOpenedChat(record, attempt + 1);
  }
}
