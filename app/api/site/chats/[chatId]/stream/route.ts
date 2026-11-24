import type { ReceivedEvent } from "eve/events";
import { z } from "zod";
import { siteUserSchema } from "@shared/identity/site-credential";
import {
  authenticateSiteRequest,
  siteError,
} from "@app/api/site/_lib/site-auth";
import { siteEveClient } from "@app/api/site/_lib/eve";
import {
  callChatEve,
  chatGrant,
  lookupSiteChat,
} from "@app/api/site/chats/_lib/chat";
import {
  chatFold,
  heartbeatLine,
  type ChatStreamLine,
} from "@app/api/site/chats/[chatId]/_lib/stream";

// A stream follows the chat live for at most this long; the site then opens
// another after the last cursor it read.
const maxStreamMs = 10 * 60_000;
const heartbeatMs = 15_000;
// The first event, which every session has, is awaited at most this long.
const firstEventMs = 20_000;
const streamInputSchema = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  siteUser: siteUserSchema,
});

// The chat's conversation as NDJSON: what came after `after`, then live,
// with a heartbeat after every 15 quiet seconds.
export async function GET(
  request: Request,
  context: RouteContext<"/api/site/chats/[chatId]/stream">
) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const query = new URL(request.url).searchParams;
  const input = streamInputSchema.safeParse({
    after: query.get("after") ?? undefined,
    siteUser: query.get("siteUser"),
  });
  if (!input.success) return siteError(400, "invalid_request");
  const { chatId } = await context.params;
  const { owner, site } = caller;
  const found = await lookupSiteChat(
    site,
    owner.scope,
    input.data.siteUser,
    chatId
  );
  if (!found.ok) return found.response;
  const { chat } = found;

  const stop = new AbortController();
  const onAbort = () => {
    stop.abort();
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  const stream = siteEveClient({
    ...chatGrant(site, chat),
    op: "chat.read",
    session: chat.sessionId,
  })
    .sessions.attach(chat.sessionId)
    .stream({ follow: true, signal: stop.signal });
  const events = stream[Symbol.asyncIterator]();
  // The first event is read before answering, so a chat eve cannot stream
  // answers an error rather than an empty stream.
  const firstDeadline = setTimeout(() => {
    stop.abort();
  }, firstEventMs);
  const opened = await callChatEve(site, async () => events.next());
  clearTimeout(firstDeadline);
  if (!opened.ok || stop.signal.aborted) {
    request.signal.removeEventListener("abort", onAbort);
    stop.abort();
    return opened.ok ? siteError(503, "unavailable") : opened.response;
  }
  const first: IteratorResult<ReceivedEvent> = opened.value;

  const fold = chatFold();
  const { after } = input.data;
  const encoder = new TextEncoder();
  let siteCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let quietSince = Date.now();
      // Once the site has gone, nothing more is written.
      const write = (line: ChatStreamLine) => {
        if (stop.signal.aborted) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        quietSince = Date.now();
      };
      const heartbeat = setInterval(() => {
        if (Date.now() - quietSince >= heartbeatMs) write(heartbeatLine());
      }, heartbeatMs / 3);
      const deadline = setTimeout(() => {
        stop.abort();
      }, maxStreamMs);
      try {
        /* oxlint-disable eslint/no-await-in-loop -- The stream is read in order, one event at a time. */
        for (
          let next = first;
          !next.done && !stop.signal.aborted;
          next = await events.next()
        ) {
          for (const line of fold(next.value)) {
            if (line.cursor > after) write(line);
          }
        }
        /* oxlint-enable eslint/no-await-in-loop */
      } catch (error) {
        if (!stop.signal.aborted) {
          console.warn("[site] chat stream ended early", {
            error: error instanceof Error ? error.name : "unknown",
            site,
          });
        }
      } finally {
        clearInterval(heartbeat);
        clearTimeout(deadline);
        request.signal.removeEventListener("abort", onAbort);
        const cancelled = siteCancelled;
        stop.abort();
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      siteCancelled = true;
      stop.abort();
    },
  });
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
}
