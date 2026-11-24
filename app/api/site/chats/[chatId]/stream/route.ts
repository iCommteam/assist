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
// eve answers a refusal or an expired chat at once, and a chat with a message
// replays its first stored line at once, so either arrives within this window
// and is answered as it is. A chat with no message yet has no event until its
// first message, so past the window it streams live from a heartbeat: the
// site must see the stream open well within its own wait. eve's client keeps
// retrying what may pass (a runtime still starting or out of reach) longer
// than the window, so that too streams from a heartbeat, until it gives up.
const openWindowMs = 2000;
const streamInputSchema = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  siteUser: siteUserSchema,
});

// The chat's conversation as NDJSON: what came after `after`, then live,
// with a heartbeat first when the chat has no message yet, and after every
// 15 quiet seconds.
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
  // The first read is awaited for a moment before answering, so a chat eve
  // cannot stream answers an error rather than an empty stream. When the
  // window passes first, the same read goes on inside the stream.
  const firstRead = callChatEve(site, async () => events.next());
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    firstRead,
    new Promise<"quiet">((resolve) => {
      openTimer = setTimeout(() => {
        resolve("quiet");
      }, openWindowMs);
    }),
  ]);
  clearTimeout(openTimer);
  if (first !== "quiet" && !first.ok) {
    request.signal.removeEventListener("abort", onAbort);
    stop.abort();
    return first.response;
  }

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
        // Headers leave only with the first line, so a quiet chat's stream
        // opens with a heartbeat.
        if (first === "quiet") write(heartbeatLine());
        const opened = first === "quiet" ? await firstRead : first;
        // A read that fails after the window ends the stream, and the site
        // opens it again; a refusal eve gives at once then answers as such.
        if (!opened.ok) return;
        /* oxlint-disable eslint/no-await-in-loop -- The stream is read in order, one event at a time. */
        for (
          let next: IteratorResult<ReceivedEvent> = opened.value;
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
