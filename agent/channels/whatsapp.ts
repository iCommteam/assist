import type {
  AttachSessionFn,
  ChannelCommitHandler,
  ChannelFrom,
  ChannelSource,
  RouteHandlerArgs,
} from "eve/channels";
import { POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";
import {
  twilioChannel,
  type TwilioChannelEvents,
  type TwilioChannelState,
  type TwilioEventContext,
  type TwilioHandle,
  type TwilioInboundResult,
  type TwilioTextMessage,
} from "eve/channels/twilio";
import { SessionNotActiveError } from "eve/client";
import type { SessionAuthContext } from "eve/context";
import {
  openInteractions,
  type Interaction,
  type SessionView,
} from "eve/events";
import { z } from "zod";
import { enrolledTeamMemberId } from "@db/services/auth/allowlist";
import {
  admitWhatsappMessage,
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
  whatsappLockOf,
  whatsappWrittenWithin,
} from "@db/services/whatsapp";
import { linkWhatsappNumber } from "@db/services/whatsapp-links";
import {
  whatsappEmailOf,
  whatsappOwnerOf,
} from "@db/services/whatsapp-numbers";
import { ensureScope } from "@db/services/scope";
import { bigqueryAccess } from "@agent/lib/bigquery/access";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { internalRouteAuth } from "@agent/lib/schedules/request";
import { settledToolResult } from "@agent/lib/settled-tool-result";
import {
  takeWhatsappCancelNotice,
  whatsappAccessOf,
  whatsappNumberOf,
  whatsappPrincipal,
  whatsappSessionOf,
} from "@agent/lib/whatsapp-access";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";

// assist on WhatsApp, through Twilio. The team's members write to the
// company's WhatsApp number and assist answers each as themselves. A member
// whose number reaches them, listed by the operator in
// ASSIST_WHATSAPP_NUMBERS or linked by the member with a code from the
// Workspace page, and who can sign in gets full access, the "whatsapp-full" mode
// (agent/lib/mode.ts): the browser, vault links, Personal Info and saved
// notes. /lock, or Lock on the Workspace page, turns it off: a locked member
// keeps today's narrow "whatsapp" chat.
// Twilio posts every incoming message to POST /eve/v1/whatsapp/messages, and
// eve checks its signature against the public URL. Every message of a full
// chat must also match Twilio's own record of it. Without
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM, every
// webhook is refused.
const route = "/eve/v1/whatsapp";
const messagesPath = `${route}/messages`;

// Twilio's limit for one WhatsApp message's text.
const maxMessageLength = 1600;
const idleChatMs = 8 * 60 * 60_000;
// WhatsApp takes free-form replies within 24 hours of the member's last
// message; replies are held from 10 minutes before that.
const replyWindowMs = 24 * 60 * 60_000 - 10 * 60_000;
// Twilio's record of a message must be at most this old when it arrives.
const recordMaxAgeMs = 10 * 60_000;
const recordReadTimeoutMs = 5000;
const recordRetryMs = 750;
const newChatCommand = "/new";
const lockCommand = "/lock";
const newChatReply = "Started a new chat. What can I help with?";
const limitReply =
  "That's the limit for now: 30 messages an hour and 200 a day. Try again later.";
const unreachableReply =
  "Twilio cannot be reached right now, so that message was not read. Try again in a minute.";
const failedTurnReply =
  "Something went wrong with that message. Try again, or reply /new to start over.";
const failedSessionReply =
  "This chat stopped. Your next message starts a new one.";

function lockReply() {
  return `Full access is off on WhatsApp. Turn it back on in assist: ${workspaceUrl()}`;
}

function workspaceUrl() {
  return new URL("/", applicationOrigin()).toString();
}

// The lines a link attempt gets. Every failure gets the same one, which names
// nothing.
function linkFailedReply() {
  return `That code did not work. Get a new one on assist's Workspace page: ${workspaceUrl()}`;
}

function linkedReply(email: string, locked: boolean) {
  return locked
    ? `This number is now connected to ${email}. Full access is off; turn it back on in assist: ${workspaceUrl()}`
    : `This number is now connected to ${email}. Full access is on; reply /lock to turn it off.`;
}

const linkTakenReply =
  "This number is connected to another assist account. Disconnect it there first.";
const linkServerReply =
  "This number is set by the server for another assist account. Only an administrator can change it.";

// The one fixed line a full chat opens with, from the channel, never the
// model: what is on, and how to turn it off. BigQuery is named only for a
// member the BigQuery tools are listed for.
async function announcement(principal: SessionAuthContext) {
  const bigquery = await bigqueryAccess({
    session: { auth: { current: principal, initiator: principal } },
  });
  const on = bigquery
    ? "the browser, vault links, Personal Info, saved notes and the company's BigQuery data, read only"
    : "the browser, vault links, Personal Info and saved notes";
  return `Full access is on in this chat: ${on}. Reply /lock to turn it off.`;
}

const events = {
  async "call.settled"(event, ctx) {
    const message = sendMessageToolResultSchema.safeParse(
      settledToolResult(event, ctx.view)
    );
    if (!message.success) return;
    try {
      const member = await replyGate(
        ctx.channel.twilio,
        ctx.session.auth.initiator
      );
      if (!member) {
        console.warn(
          "[whatsapp] the chat may no longer reach its number; the reply is not sent"
        );
        return;
      }
      await deliver(ctx.channel.twilio, member, message.data.output);
    } catch (error) {
      warnByName("a reply could not be sent", error);
    }
  },
  // A reply reaches WhatsApp only through send_message, so the model's own
  // text is never posted.
  // oxlint-disable-next-line eslint/no-empty-function -- Overriding the built-in handler suppresses automatic reply posting.
  async "content.completed"() {},
  // eve posts a sign-in's challenge here, and its end below. WhatsApp shows
  // none: the access hook cancels every sign-in and approval
  // (agent/hooks/whatsapp-access.ts), and a question reaches the member
  // through `committed`, below.
  // oxlint-disable-next-line eslint/no-empty-function -- Overriding the built-in handler posts no sign-in.
  async "interaction.opened"() {},
  // oxlint-disable-next-line eslint/no-empty-function -- Overriding the built-in handler posts no sign-in.
  async "interaction.settled"() {},
  // eve's own notices are replaced by fixed ones that pass the same gate as
  // replies.
  async "turn.settled"(event, ctx) {
    const notice =
      event.data.outcome === "failed"
        ? failedTurnReply
        : event.data.outcome === "cancelled"
          ? takeWhatsappCancelNotice(ctx.session.id, event.data.turnId)
          : undefined;
    if (notice === undefined) return;
    await postNotice(ctx.channel.twilio, ctx.session.auth.initiator, notice);
  },
  async "session.ended"(event, ctx) {
    await recordChatEnd(ctx.session.id);
    if (event.data.outcome !== "failed") return;
    await postNotice(
      ctx.channel.twilio,
      ctx.session.auth.initiator,
      failedSessionReply
    );
  },
} satisfies TwilioChannelEvents;

// The question or budget prompt a typed reply answers now, posted through
// the same gate as replies. eve's own prompt queue for text channels does the
// same, ungated; this replaces it. A typed reply answers eve's first open
// request, so the prompt shown must be that one: a budget prompt first, then
// the oldest, skipping sign-ins and any already answered.
const committed: ChannelCommitHandler<TwilioEventContext> = async (
  _line,
  ctx
) => {
  const { state, twilio } = ctx.channel;
  const head = promptHead(ctx.view);
  if (head === undefined) {
    Object.assign(state, { shownPromptId: undefined });
    return;
  }
  if (
    shownPromptSchema.safeParse(state).data?.shownPromptId ===
    head.interactionId
  ) {
    return;
  }
  try {
    const member = await replyGate(twilio, ctx.session.auth.initiator);
    if (!member || !(await windowOpen(member.number))) return;
    await send(twilio, { Body: promptText(head.request) });
    Object.assign(state, { shownPromptId: head.interactionId });
  } catch (error) {
    warnByName("a question could not be sent", error);
  }
};

// The channel state eve's own prompt queue keeps, so a prompt it already
// showed in a session started before this channel took over is not repeated.
const shownPromptSchema = z.looseObject({
  shownPromptId: z.string().optional(),
});

function promptHead(view: SessionView) {
  const open = openInteractions(view).filter(
    (interaction) =>
      interaction.request.kind !== "sign-in" && interaction.answer === undefined
  );
  return (
    open.find((interaction) => interaction.request.kind === "budget") ?? open[0]
  );
}

// As eve renders a prompt for a text channel, so a reply with an option's
// number or label answers it.
function promptText(request: Interaction["request"]) {
  const options = request.options ?? [];
  const lines = [request.prompt];
  if (options.length > 0) {
    lines.push(
      "",
      ...options.map(
        (option, index) =>
          `${String(index + 1)}. ${option.label}${option.description ? ` - ${option.description}` : ""}`
      )
    );
  }
  const text = lines.join("\n");
  if (options.length === 0) return text;
  return `${text}\n\n${
    request.allowFreeform === true
      ? "Reply with a number, or with your own answer."
      : "Reply with a number to choose."
  }`;
}

// `committed` is a channel event eve accepts from every channel
// (ChannelEvents in eve/channels), and twilioChannel spreads these over its
// defaults, which hold eve's own prompt queue; its TwilioChannelEvents type
// does not list it, so it is passed as a value of a wider type.
const channelEvents: TwilioChannelEvents & {
  readonly committed: ChannelCommitHandler<TwilioEventContext>;
} = { ...events, committed };

const channel = twilioChannel({
  // Every verified sender reaches onText, which answers members' numbers and
  // link attempts only: anyone else gets an empty reply and reaches nothing.
  allowFrom: "*",
  credentials: {
    accountSid: () => required(env.TWILIO_ACCOUNT_SID, "TWILIO_ACCOUNT_SID"),
    authToken: () => required(env.TWILIO_AUTH_TOKEN, "TWILIO_AUTH_TOKEN"),
  },
  events: channelEvents,
  messaging: { from: env.TWILIO_WHATSAPP_FROM },
  onText: (ctx, message) => admit(ctx.twilio, message),
  // WhatsApp brings no calls: a call, or a transcript, reaches nobody.
  onVoice: () => null,
  onVoiceTranscription: () => null,
  route,
  webhookUrl: publicWebhookUrl,
});

// Loopback callbacks from this machine's Next server, with
// SCHEDULED_RUN_SECRET as the bearer: a lock pressed on the Workspace page
// ends the member's full chats, or everyone's, and a number disconnected
// there ends the member's full chats on that number.
const endInputSchema = z.strictObject({
  member: z.union([z.literal("*"), z.string().min(1).max(200)]),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/u)
    .optional(),
});

const internalRoutes = [
  POST("/internal/whatsapp/end", async (request, { attachSession }) => {
    const auth = await routeAuth(request, internalRouteAuth);
    if (auth instanceof Response) return auth;
    const input = endInputSchema.safeParse(await request.json());
    if (!input.success) return new Response(null, { status: 400 });
    const chats = await openWhatsappChats(
      input.data.member === "*" ? undefined : input.data.member,
      input.data.phone
    );
    await endRecordedChats(
      attachSession,
      chats,
      input.data.phone === undefined
        ? "WhatsApp was locked."
        : "The number was disconnected."
    );
    return new Response(null, { status: 204 });
  }),
];

// Unset, every webhook is refused before anything reads it. A message the
// messages route dispatches goes to its member's current chat on that number,
// which /new, a long silence, a lock and a change of level replace.
export default {
  ...channel,
  routes: [
    // oxlint-disable-next-line oxc/no-map-spread -- Keep eve's original route definitions intact when adding the closed check.
    ...channel.routes.map((definition) => {
      if (definition.transport === "websocket") return definition;
      return {
        ...definition,
        async handler(request, args) {
          if (!whatsappConfigured()) {
            return new Response("forbidden", { status: 403 });
          }
          return definition.handler(
            request,
            definition.path === messagesPath
              ? { ...args, from: chatSessions(args) }
              : args
          );
        },
      } satisfies (typeof channel.routes)[number];
    }),
    ...internalRoutes,
  ],
} satisfies typeof channel;

function required(value: string | undefined, name: string) {
  if (value === undefined) throw new Error(`${name} is required.`);
  return value;
}

function whatsappConfigured() {
  return (
    env.TWILIO_ACCOUNT_SID !== undefined &&
    env.TWILIO_AUTH_TOKEN !== undefined &&
    env.TWILIO_WHATSAPP_FROM !== undefined
  );
}

// Twilio signs the URL it called, the public one; behind Next, eve sees its
// own loopback address instead.
function publicWebhookUrl(request: Request) {
  const { pathname, search } = new URL(request.url);
  return new URL(`${pathname}${search}`, applicationOrigin()).toString();
}

const messageSidPattern = /^[A-Z]{2}[0-9a-f]{32}$/u;

// Decides whether a verified message reaches the agent, and as whom. Only a
// WhatsApp message to the configured number from a number that reaches a
// member, listed or linked, does, once per message id, while the member can
// still sign in to assist, and within their limits. A member who has not
// locked WhatsApp gets full access, and each of their messages must match
// Twilio's own record of it; /lock locks it without that check, since it only
// ever turns access off. Only a member who can sign in is recorded, counted,
// or ever told of the limit. A message that is only "link <code>" is a link
// attempt instead, from any number (linkAttempt, below).
async function admit(
  twilio: TwilioHandle,
  message: TwilioTextMessage
): Promise<TwilioInboundResult> {
  const sender = whatsappNumberOf(message.from);
  if (!sender || message.to !== env.TWILIO_WHATSAPP_FROM) return null;
  const sid = message.messageSid;
  if (!sid || !messageSidPattern.test(sid)) return null;
  // Taken before the first await, so the sender's messages keep the order in
  // which they reach this point.
  const turn = takeTurn(sender);
  let handedOn = false;
  try {
    const owner = await whatsappOwnerOf(sender);
    // Listed for two emails: it reaches nobody, and is never linked.
    if (owner && owner.email === undefined) return null;
    const code = linkCodeOf(message);
    if (code !== undefined) {
      const linked = await linkAttempt(twilio, message, {
        code,
        listing:
          owner?.source === "server" ? { email: owner.email } : undefined,
        sender,
        sid,
      });
      if (!linked) return null;
      handOn(sid, { ...linked, turn });
      handedOn = true;
      return { auth: null };
    }
    const email = owner?.email;
    if (!email) return null;
    const userId = await enrolledTeamMemberId(email);
    if (!userId) {
      console.warn("[whatsapp] a member's number cannot sign in; ignoring");
      return null;
    }
    if (!(await claimWhatsappMessage(sid, sender))) return null;
    const command = commandOf(message);
    if (command === "lock") {
      await lockWhatsapp(userId, "whatsapp");
      // The lock holds over the limit too; only its reply is counted.
      const counted = await countWhatsappMessage(sid, sender, messageWindows);
      handOn(sid, { command, reply: counted, sender, turn, twilio, userId });
      handedOn = true;
      return { auth: whatsappPrincipal(userId, email, { level: "narrow" }) };
    }
    const lock = await whatsappLockOf(userId);
    const level = lock.self || lock.everyone ? "narrow" : "full";
    if (level === "full") {
      const record = await twilioRecordCheck(message, sender, sid);
      if (record === "unreachable") {
        await sendQuietly(twilio, unreachableReply, "unreachable notice");
        return null;
      }
      if (record === "differs") {
        console.warn(
          "[whatsapp] a message does not match Twilio's record of it; dropped"
        );
        return null;
      }
    }
    await admitWhatsappMessage(sid);
    if (!(await countWhatsappMessage(sid, sender, messageWindows))) {
      await tellLimitOnce(twilio, sender);
      return null;
    }
    handOn(sid, {
      arrivedAt: new Date(),
      command,
      email,
      level,
      sender,
      turn,
      twilio,
      userId,
    });
    handedOn = true;
    return {
      auth: whatsappPrincipal(
        userId,
        email,
        level === "full" ? { level, number: sender } : { level }
      ),
    };
  } catch (error) {
    warnByName("a message could not be admitted and is dropped", error);
    return null;
  } finally {
    if (!handedOn) turn.release();
  }
}

// "link" and a code of 8 letters and digits, in any case, with any spaces
// around them and at most one space or dash in the middle.
const linkCommandPattern = /^link\s+([a-z0-9]{4})[\s-]?([a-z0-9]{4})$/iu;

function linkCodeOf(message: TwilioTextMessage) {
  if ((message.media ?? []).length > 0) return undefined;
  const [, head, tail] = linkCommandPattern.exec(message.body.trim()) ?? [];
  if (head === undefined || tail === undefined) return undefined;
  return `${head}${tail}`.toUpperCase();
}

// "link <code>": the member connects the sending number to their assist
// account with a code from the Workspace page
// (db/services/whatsapp-links.ts). Whoever sends it, it is checked as a full
// chat's message is, once per message id and against Twilio's own record of
// it, so a forged or replayed webhook links nothing. Every outcome is one
// fixed line from the channel, except an attempt over the limit on failures,
// which gets none. A member who linked this number in place of another is
// handed on, so the other number's full chats end.
async function linkAttempt(
  twilio: TwilioHandle,
  message: TwilioTextMessage,
  attempt: {
    readonly code: string;
    readonly listing: { readonly email: string | undefined } | undefined;
    readonly sender: string;
    readonly sid: string;
  }
) {
  if (!(await claimWhatsappMessage(attempt.sid, attempt.sender))) {
    return undefined;
  }
  const record = await twilioRecordCheck(message, attempt.sender, attempt.sid);
  if (record === "unreachable") {
    await sendQuietly(twilio, unreachableReply, "unreachable notice");
    return undefined;
  }
  if (record === "differs") {
    console.warn(
      "[whatsapp] a link message does not match Twilio's record of it; dropped"
    );
    return undefined;
  }
  await admitWhatsappMessage(attempt.sid);
  const result = await linkWhatsappNumber({
    code: attempt.code,
    listing: attempt.listing,
    phone: attempt.sender,
    sid: attempt.sid,
  });
  if (result.outcome === "limited") {
    console.warn("[whatsapp] a link attempt is over the limit; ignored");
    return undefined;
  }
  if (result.outcome !== "linked") {
    await send(twilio, {
      Body:
        result.outcome === "already"
          ? `This number is already connected to ${result.email}.`
          : result.outcome === "taken"
            ? linkTakenReply
            : result.outcome === "server"
              ? linkServerReply
              : linkFailedReply(),
    });
    return undefined;
  }
  const lock = await whatsappLockOf(result.userId);
  await send(twilio, {
    Body: linkedReply(result.email, lock.self || lock.everyone),
  });
  if (result.previousPhone === undefined) return undefined;
  return {
    command: "link" as const,
    previousPhone: result.previousPhone,
    userId: result.userId,
  };
}

function commandOf(message: TwilioTextMessage) {
  if ((message.media ?? []).length > 0) return undefined;
  const text = message.body.trim().toLowerCase();
  if (text === newChatCommand) return "new" as const;
  if (text === lockCommand) return "lock" as const;
  return undefined;
}

// Twilio's own record of a message, read with the account's credentials,
// must say what the signed webhook said: an inbound message to our number
// from the sender, with the same body, created at most 10 minutes ago, and
// the same media. eve hands the model each media item from its MediaUrl and
// MediaContentType fields, so every one must name a media item of this very
// message on Twilio's own list of it, with the same content type, and the
// list must hold no other. A message Twilio has no record of, or one that
// differs, is dropped whole, since onText cannot take a part of it away; a
// record that cannot be read leaves the message unread, and the member is
// told to try again.
const twilioRecordSchema = z.object({
  account_sid: z.string(),
  body: z.string().nullable(),
  date_created: z.string(),
  direction: z.string(),
  from: z.string(),
  num_media: z.union([z.string(), z.number()]),
  sid: z.string(),
  to: z.string(),
});

const twilioMediaListSchema = z.object({
  media_list: z.array(
    z.object({
      account_sid: z.string(),
      content_type: z.string(),
      parent_sid: z.string(),
      sid: z.string(),
    })
  ),
  next_page_uri: z.string().nullable().optional(),
});

// The only form a media item's address takes in Twilio's webhook, compared
// as the whole string: no other host, port, path, query or encoding.
const twilioMediaUrlPattern =
  /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\/Messages\/([A-Z]{2}[0-9a-f]{32})\/Media\/(ME[0-9a-f]{32})$/u;

async function twilioRecordCheck(
  message: TwilioTextMessage,
  sender: string,
  sid: string
) {
  const accountSid = required(env.TWILIO_ACCOUNT_SID, "TWILIO_ACCOUNT_SID");
  const messageUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages/${encodeURIComponent(sid)}`;
  const recordRead = await readTwilioRecord(`${messageUrl}.json`);
  if (recordRead.outcome !== "read") return recordRead.outcome;
  const record = twilioRecordSchema.safeParse(recordRead.body);
  if (!record.success) return "differs" as const;
  const createdAt = Date.parse(record.data.date_created);
  const age = Date.now() - createdAt;
  const media = message.media ?? [];
  const matches =
    record.data.sid === sid &&
    record.data.account_sid === accountSid &&
    record.data.direction === "inbound" &&
    record.data.to === env.TWILIO_WHATSAPP_FROM &&
    record.data.from === `whatsapp:${sender}` &&
    (record.data.body ?? "") === message.body &&
    Number(record.data.num_media) === media.length &&
    Number.isFinite(createdAt) &&
    age <= recordMaxAgeMs &&
    age >= -60_000;
  if (!matches) return "differs" as const;
  if (media.length === 0) return "matches" as const;
  const listRead = await readTwilioRecord(`${messageUrl}/Media.json`);
  if (listRead.outcome !== "read") return listRead.outcome;
  const list = twilioMediaListSchema.safeParse(listRead.body);
  if (!list.success) return "differs" as const;
  return mediaMatches(media, list.data, accountSid, sid)
    ? ("matches" as const)
    : ("differs" as const);
}

function mediaMatches(
  media: NonNullable<TwilioTextMessage["media"]>,
  list: z.infer<typeof twilioMediaListSchema>,
  accountSid: string,
  sid: string
) {
  if (list.next_page_uri) return false;
  const listed = new Map(
    list.media_list
      .filter(
        (item) =>
          item.account_sid === accountSid &&
          item.parent_sid === sid &&
          /^ME[0-9a-f]{32}$/u.test(item.sid)
      )
      .map((item) => [item.sid, item.content_type])
  );
  if (listed.size !== list.media_list.length || listed.size !== media.length) {
    return false;
  }
  const seen = new Set<string>();
  for (const item of media) {
    const [, account, parent, mediaSid] =
      twilioMediaUrlPattern.exec(item.url) ?? [];
    if (
      account !== accountSid ||
      parent !== sid ||
      mediaSid === undefined ||
      seen.has(mediaSid) ||
      listed.get(mediaSid) !== item.contentType
    ) {
      return false;
    }
    seen.add(mediaSid);
  }
  return true;
}

// One read of Twilio's API with the account's credentials: its JSON body;
// "differs" when Twilio has no such record, read once more after a short
// pause; or "unreachable".
async function readTwilioRecord(url: string) {
  const accountSid = required(env.TWILIO_ACCOUNT_SID, "TWILIO_ACCOUNT_SID");
  const authToken = required(env.TWILIO_AUTH_TOKEN, "TWILIO_AUTH_TOKEN");
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A record that is not there yet is read once more, after a pause.
      response = await fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(recordReadTimeoutMs),
      });
    } catch {
      return { outcome: "unreachable" as const };
    }
    if (response.status === 404 && attempt === 0) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The pause before the second read.
      await new Promise((resolve) => setTimeout(resolve, recordRetryMs));
      continue;
    }
    if (response.status === 404) return { outcome: "differs" as const };
    if (!response.ok) return { outcome: "unreachable" as const };
    // oxlint-disable-next-line eslint/no-await-in-loop -- The loop ends here.
    return { body: await readJson(response), outcome: "read" as const };
  }
}

async function readJson(response: Response) {
  try {
    return z.json().parse(await response.json());
  } catch {
    return undefined;
  }
}

// Each message spends model time, so a number is capped: 30 messages in any
// hour and 200 in any day, /new and /lock included. The database holds the
// counts, so they survive a restart.
const messageWindows = [
  { max: 30, ms: 60 * 60_000 },
  { max: 200, ms: 24 * 60 * 60_000 },
] as const;

// A member over the limit is told once an hour, and their messages are
// dropped meanwhile. Memory holds when they were told: after a restart they
// may be told once more.
const limitNoticeMs = 60 * 60_000;
const limitNotices = new Map<string, number>();

async function tellLimitOnce(twilio: TwilioHandle, sender: string) {
  const now = Date.now();
  if (now - (limitNotices.get(sender) ?? 0) < limitNoticeMs) return;
  limitNotices.set(sender, now);
  await sendQuietly(twilio, limitReply, "limit notice");
}

async function sendQuietly(twilio: TwilioHandle, text: string, what: string) {
  try {
    await send(twilio, { Body: text });
  } catch (error) {
    console.warn(`[whatsapp] the ${what} could not be sent`, {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// A sender's messages reach their chat one at a time, in the order they reach
// admit, which is after eve's signature check; Twilio itself promises no
// order. Each message takes its turn there, before any await, and waits for
// the turn before it to settle, so a message right after /new or a long
// silence cannot reach the chat being ended, or end the new one. The service
// runs one replica, so memory holds the queue: the last turn of each number
// whose turns have not all settled, which then leaves it.
const senderQueues = new Map<string, Promise<unknown>>();

function takeTurn(sender: string) {
  const previous = senderQueues.get(sender) ?? Promise.resolve();
  const settled = Promise.withResolvers<undefined>();
  const queued = Promise.all([previous, settled.promise]);
  senderQueues.set(sender, queued);
  void queued.finally(() => {
    if (senderQueues.get(sender) === queued) senderQueues.delete(sender);
  });
  return {
    previous,
    release: () => {
      settled.resolve(undefined);
    },
  };
}

type Admitted =
  | {
      readonly command: "link";
      readonly previousPhone: string;
      readonly turn: ReturnType<typeof takeTurn>;
      readonly userId: string;
    }
  | {
      readonly command: "lock";
      readonly reply: boolean;
      readonly sender: string;
      readonly turn: ReturnType<typeof takeTurn>;
      readonly twilio: TwilioHandle;
      readonly userId: string;
    }
  | {
      readonly arrivedAt: Date;
      readonly command: "new" | undefined;
      readonly email: string;
      readonly level: "full" | "narrow";
      readonly sender: string;
      readonly turn: ReturnType<typeof takeTurn>;
      readonly twilio: TwilioHandle;
      readonly userId: string;
    };

// The messages admit let through that their chat has not yet taken, by
// message id. eve hands an admitted message to its chat at once; one it never
// hands on gives its turn up after 10 seconds, so it cannot hold up the
// sender's later messages.
const unclaimedTurnMs = 10_000;
const admittedMessages = new Map<
  string,
  { readonly admitted: Admitted; readonly timer: ReturnType<typeof setTimeout> }
>();

function handOn(messageSid: string, admitted: Admitted) {
  const timer = setTimeout(() => {
    claimAdmitted(messageSid)?.turn.release();
  }, unclaimedTurnMs);
  admittedMessages.set(messageSid, { admitted, timer });
}

function claimAdmitted(messageSid: string | null | undefined) {
  const entry = messageSid ? admittedMessages.get(messageSid) : undefined;
  if (!messageSid || !entry) return undefined;
  admittedMessages.delete(messageSid);
  clearTimeout(entry.timer);
  return entry.admitted;
}

// One chat per member, number and level. /new ends it and starts nothing, a
// message more than 8 hours after the chat's last activity starts a new one,
// and a message at another level, after a lock or an unlock, starts a new one
// and ends the chat at the other level. eve keeps the address, so the next
// message after an end starts a fresh session there. Only send is used on the
// messages route.
function chatSessions(
  args: RouteHandlerArgs<TwilioChannelState>
): ChannelFrom<TwilioChannelState> {
  return (address) => ({
    ...args.from(address),
    async send(message, options) {
      const claimed = claimAdmitted(options.state?.lastMessageSid);
      await claimed?.turn.previous;
      try {
        if (claimed?.command === "lock") {
          return await lockChats(args, address, options.auth, claimed);
        }
        if (claimed?.command === "link") {
          return await endPreviousNumber(args, claimed);
        }
        const now = claimed ? await admittedNow(claimed, options) : undefined;
        if (claimed && !now) {
          return noDelivery(
            new Error(
              "The member's WhatsApp access ended as the message arrived."
            )
          );
        }
        const admitted = now?.admitted;
        const sendOptions = now?.options ?? options;
        const chat = memberChat(address, sendOptions.auth);
        const source = args.from(chat);
        if (admitted?.command === "new") {
          await sendHeldReplies(admitted);
          const ended = await endChat(source, "The member started a new chat.");
          await send(admitted.twilio, { Body: newChatReply });
          return ended;
        }
        await endOtherLevel(args, address, sendOptions.auth);
        if (await idleTooLong(args, chat)) {
          await endChat(source, "The chat was idle for 8 hours.");
        }
        if (admitted) await sendHeldReplies(admitted);
        const delivery = await source.send(message, sendOptions);
        if (admitted?.level === "full") {
          await openFullChat(admitted, delivery.sessionId, sendOptions);
        }
        return delivery;
      } finally {
        claimed?.turn.release();
      }
    },
  });
}

type SendOptions = Parameters<ChannelSource<TwilioChannelState>["send"]>[1];

// admit read the member's access before Twilio's record check and before the
// sender's earlier message reached its chat, so a lock may have landed since,
// from /lock or the Workspace page. A message admitted with full access is
// read again as it reaches its chat: still full, it goes on; locked, it goes
// to the narrow chat, as admit would let it through now, so no full chat
// opens and no full chat's held reply is sent; with WhatsApp gone
// altogether, or when the access cannot be read, it is dropped.
async function admittedNow(
  admitted: Extract<Admitted, { command: "new" | undefined }>,
  options: SendOptions
) {
  if (admitted.level !== "full") return { admitted, options };
  let access: Awaited<ReturnType<typeof whatsappAccessOf>>;
  try {
    access = await whatsappAccessOf({
      email: admitted.email,
      number: admitted.sender,
      principalId: `better-auth:${admitted.userId}`,
    });
  } catch (error) {
    warnByName("the member's access could not be read; dropped", error);
    return undefined;
  }
  if (access === "full") return { admitted, options };
  if (access === "none") return undefined;
  return {
    admitted: { ...admitted, level: "narrow" as const },
    options: {
      ...options,
      auth: whatsappPrincipal(admitted.userId, admitted.email, {
        level: "narrow",
      }),
    },
  };
}

// The chat's address joins the member to the number, and a full chat's also
// names its level: a number that later reaches someone else starts a chat of
// theirs and never reaches the earlier member's, and a locked member's
// narrow chat keeps the address every chat had before full access.
function memberChat(address: string, auth: SessionAuthContext | null) {
  const member = whatsappSessionOf(auth);
  if (!auth || !member) {
    throw new Error("A WhatsApp message reached its chat unadmitted.");
  }
  return member.level === "full"
    ? `${address}|${auth.principalId}|full`
    : `${address}|${auth.principalId}`;
}

function otherLevelChat(address: string, auth: SessionAuthContext | null) {
  const member = whatsappSessionOf(auth);
  if (!auth || !member) return undefined;
  return member.level === "full"
    ? `${address}|${auth.principalId}`
    : `${address}|${auth.principalId}|full`;
}

async function endOtherLevel(
  args: RouteHandlerArgs<TwilioChannelState>,
  address: string,
  auth: SessionAuthContext | null
) {
  const other = otherLevelChat(address, auth);
  if (other === undefined) return;
  try {
    if (!(await args.resolveSession(other))) return;
  } catch {
    return;
  }
  const ended = await endChat(
    args.from(other),
    "The member's WhatsApp access changed."
  );
  if (ended.sessionId !== "") await recordChatEnd(ended.sessionId);
}

// /lock: the lock is already written. Every full chat of the member ends, on
// any number, and the member is told, unless the message was over the limit.
async function lockChats(
  args: RouteHandlerArgs<TwilioChannelState>,
  address: string,
  auth: SessionAuthContext | null,
  admitted: Extract<Admitted, { command: "lock" }>
) {
  const principalId = `better-auth:${admitted.userId}`;
  let chats: Awaited<ReturnType<typeof openWhatsappChats>> = [];
  try {
    chats = await openWhatsappChats(principalId);
  } catch (error) {
    warnByName("the member's full chats could not be read", error);
  }
  await endRecordedChats(
    args.attachSession,
    chats,
    "The member locked WhatsApp."
  );
  const ended = await endChat(
    args.from(`${address}|${auth?.principalId ?? principalId}|full`),
    "The member locked WhatsApp."
  );
  if (admitted.reply) await send(admitted.twilio, { Body: lockReply() });
  return ended;
}

// A member who linked a number in place of another: every full chat of
// theirs on the other number ends, as a lock ends them. The link message
// reaches no chat.
async function endPreviousNumber(
  args: RouteHandlerArgs<TwilioChannelState>,
  admitted: Extract<Admitted, { command: "link" }>
) {
  let chats: Awaited<ReturnType<typeof openWhatsappChats>> = [];
  try {
    chats = await openWhatsappChats(
      `better-auth:${admitted.userId}`,
      admitted.previousPhone
    );
  } catch (error) {
    warnByName("the earlier number's chats could not be read", error);
  }
  await endRecordedChats(
    args.attachSession,
    chats,
    "The member linked another number."
  );
  return noDelivery(new Error("A link message reaches no chat."));
}

async function endRecordedChats(
  attachSession: AttachSessionFn,
  chats: Awaited<ReturnType<typeof openWhatsappChats>>,
  reason: string
) {
  await Promise.all(
    chats.map(async ({ sessionId }) => {
      await endSession(attachSession(sessionId), reason);
      await recordChatEnd(sessionId);
    })
  );
}

// Records the full chat the message reached and, the first time, sends the
// chat's fixed line.
async function openFullChat(
  admitted: Extract<Admitted, { command: "new" | undefined }>,
  sessionId: string,
  options: SendOptions
) {
  const messageSid = options.state?.lastMessageSid;
  if (!options.auth || !messageSid || sessionId === "") return;
  try {
    // The session-owner hook creates the workspace as the session starts,
    // which may not have happened yet.
    const scope = scopeFromPrincipal(options.auth);
    await ensureScope(scope);
    const chat = await recordWhatsappChat({
      email: admitted.email,
      messageAt: admitted.arrivedAt,
      messageSid,
      phone: admitted.sender,
      sessionId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
    });
    if (chat.announcedAt !== null) return;
    // A lock that landed as the chat opened: no line says full access is on.
    const access = await whatsappAccessOf({
      email: admitted.email,
      number: admitted.sender,
      principalId: `better-auth:${admitted.userId}`,
    });
    if (access !== "full") return;
    const line = await announcement(options.auth);
    if (await claimWhatsappChatAnnouncement(chat.id)) {
      await send(admitted.twilio, { Body: line });
    }
  } catch (error) {
    console.warn("[whatsapp] the chat could not be recorded", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// Ends the chat at the address. With none open there, or one that stopped
// meanwhile, there is nothing to end: the receipt then names no session, and
// waiting on it says why. Any other failure is the caller's.
async function endChat(
  source: ChannelSource<TwilioChannelState>,
  reason: string
): ReturnType<ChannelSource<TwilioChannelState>["end"]> {
  try {
    return await source.end({ reason });
  } catch (error) {
    if (!SessionNotActiveError.is(error) || error.retryable) throw error;
    return noDelivery(error);
  }
}

// A receipt that names no session: waiting on it says why.
function noDelivery(
  error: Error
): Awaited<ReturnType<ChannelSource<TwilioChannelState>["end"]>> {
  return {
    deliveryId: "",
    result: async () => {
      throw error;
    },
    sessionId: "",
    async *stream() {
      yield* [];
    },
  };
}

// The chat's end in its row. A failure is logged by name only, as every
// database failure here is: eve logs a thrown error whole, and a failed
// query's message names its values, numbers and reply text among them.
async function recordChatEnd(sessionId: string) {
  try {
    await endWhatsappChat(sessionId);
  } catch (error) {
    warnByName("the chat's end could not be recorded", error);
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A caught value is unknown by nature; only its name is read.
function warnByName(what: string, error: unknown) {
  console.warn(`[whatsapp] ${what}`, {
    error: error instanceof Error ? error.name : "unknown",
  });
}

async function endSession(
  session: Pick<ReturnType<AttachSessionFn>, "end">,
  reason: string
) {
  try {
    await session.end({ reason });
  } catch (error) {
    if (SessionNotActiveError.is(error) && !error.retryable) return;
    console.warn("[whatsapp] a chat could not be ended", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// The last activity is the time of the session's last recorded line, so it
// survives a restart. When it cannot be read, the chat goes on.
async function idleTooLong(
  args: RouteHandlerArgs<TwilioChannelState>,
  address: string
) {
  try {
    const session = await args.resolveSession(address);
    if (!session) return false;
    let lastAt = Number.NEGATIVE_INFINITY;
    for await (const event of session.stream({
      follow: false,
      signal: AbortSignal.timeout(10_000),
      startIndex: -1,
    })) {
      lastAt = Math.max(lastAt, Date.parse(event.meta.at));
    }
    return Number.isFinite(lastAt) && Date.now() - lastAt > idleChatMs;
  } catch (error) {
    console.warn("[whatsapp] the chat's last activity could not be read", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

// Whether the chat may still post to its number, and as which member: the
// number must still reach the chat's member, listed or linked, so a number
// given to someone else never receives the earlier member's replies, even
// from a turn sent on the web; a full chat's member must still have full
// access, on the chat's own number.
async function replyGate(
  twilio: TwilioHandle,
  initiator: SessionAuthContext | null
) {
  const number = whatsappNumberOf(twilio.from);
  const member = whatsappSessionOf(initiator);
  if (number === undefined || !member) return undefined;
  if ((await whatsappEmailOf(number)) !== member.email) return undefined;
  if (member.level === "full") {
    if (member.number !== number) return undefined;
    if ((await whatsappAccessOf(member)) !== "full") return undefined;
  }
  return {
    level: member.level,
    number,
    userId: member.principalId,
  };
}

type Member = NonNullable<Awaited<ReturnType<typeof replyGate>>>;

async function postNotice(
  twilio: TwilioHandle,
  initiator: SessionAuthContext | null,
  notice: string
) {
  try {
    const member = await replyGate(twilio, initiator);
    if (!member) return;
    await deliver(twilio, member, { kind: "message", text: notice });
  } catch (error) {
    console.warn("[whatsapp] a notice could not be sent", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

async function windowOpen(number: string) {
  return whatsappWrittenWithin(number, replyWindowMs);
}

type Part = { readonly Body: string } | { readonly MediaUrl: string };

// Sends one reply: its text in parts of at most 1,600 characters, then each
// attachment as a message of its own, since a WhatsApp message carries at
// most one media item. Outside the member's 24-hour window it is held
// instead, and goes first when they next write.
async function deliver(
  twilio: TwilioHandle,
  member: Member,
  reply: z.infer<typeof sendMessageToolResultSchema>["output"]
) {
  const parts: Part[] =
    reply.kind === "link"
      ? [{ Body: reply.url }]
      : [
          ...messageParts(reply.text ?? "").map((Body) => ({ Body })),
          ...(reply.attachments ?? []).map(({ url }) => ({ MediaUrl: url })),
        ];
  if (!(await windowOpen(member.number))) {
    for (const part of parts) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The parts are held in order.
      await holdWhatsappReply({
        content:
          "Body" in part ? { body: part.Body } : { mediaUrl: part.MediaUrl },
        level: member.level,
        phone: member.number,
        userId: member.userId,
      });
    }
    console.info("[whatsapp] a reply outside the 24-hour window is held");
    return;
  }
  for (const part of parts) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The parts must arrive in order.
    await send(twilio, part);
  }
}

// The replies held for this member on this number, sent in order before
// their new message reaches the chat, or before /new ends it. A full chat's
// held reply goes only while full access is on; one that fails to send
// stays, with those after it.
async function sendHeldReplies(
  admitted: Extract<Admitted, { command: "new" | undefined }>
) {
  try {
    const held = await heldWhatsappReplies(
      `better-auth:${admitted.userId}`,
      admitted.sender
    );
    for (const reply of held) {
      if (reply.level === "full" && admitted.level !== "full") {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Held replies go in order.
        await dropHeldWhatsappReply(reply.id);
        continue;
      }
      const part: Part | undefined =
        reply.body !== null
          ? { Body: reply.body }
          : reply.mediaUrl !== null
            ? { MediaUrl: reply.mediaUrl }
            : undefined;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Held replies go in order.
      if (part) await send(admitted.twilio, part);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Held replies go in order.
      await dropHeldWhatsappReply(reply.id);
    }
  } catch (error) {
    console.warn("[whatsapp] held replies could not all be sent", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// Splits text at the last paragraph break, line break or space that leaves
// at least half a message, and otherwise exactly at the limit, never inside
// a surrogate pair.
function messageParts(text: string) {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > maxMessageLength) {
    const cut = cutPoint(rest);
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== "") parts.push(rest);
  return parts;
}

function cutPoint(text: string) {
  for (const separator of ["\n\n", "\n", " "]) {
    const at = text.lastIndexOf(separator, maxMessageLength);
    if (at >= maxMessageLength / 2) return at;
  }
  const last = text.charCodeAt(maxMessageLength - 1);
  return last >= 0xd8_00 && last <= 0xdb_ff
    ? maxMessageLength - 1
    : maxMessageLength;
}

// One WhatsApp message to the conversation's member, from the configured
// number. Twilio's refusal fails the delivery; its body is not logged, since
// it names the numbers.
async function send(twilio: TwilioHandle, content: Part) {
  const response = await twilio.request(
    `/2010-04-01/Accounts/${encodeURIComponent(required(env.TWILIO_ACCOUNT_SID, "TWILIO_ACCOUNT_SID"))}/Messages.json`,
    {
      ...content,
      From: required(env.TWILIO_WHATSAPP_FROM, "TWILIO_WHATSAPP_FROM"),
      To: twilio.from,
    }
  );
  if (!response.ok) {
    throw new Error(
      `Twilio refused a WhatsApp message with HTTP ${String(response.status)}.`
    );
  }
}
