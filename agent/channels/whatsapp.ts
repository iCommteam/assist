import type {
  ChannelFrom,
  ChannelSource,
  RouteHandlerArgs,
} from "eve/channels";
import {
  twilioChannel,
  type TwilioChannelState,
  type TwilioHandle,
  type TwilioInboundResult,
  type TwilioTextMessage,
} from "eve/channels/twilio";
import { SessionNotActiveError } from "eve/client";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { enrolledTeamMemberId } from "@db/services/auth/allowlist";
import { settledToolResult } from "@agent/lib/settled-tool-result";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { env, whatsappNumbersVariable } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import { accessScopeForUser } from "@shared/identity/access-scope";

// assist on WhatsApp, through Twilio. The team's members write to the
// company's WhatsApp number and assist answers each as themselves, in the
// narrow "whatsapp" mode (agent/lib/mode.ts). Twilio posts every incoming
// message to POST /eve/v1/whatsapp/messages, and eve checks its signature
// against the public URL. Without TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_WHATSAPP_FROM, every webhook is refused.
const route = "/eve/v1/whatsapp";
const messagesPath = `${route}/messages`;

// The authenticator of a WhatsApp session's principal, which decides its
// mode.
const whatsappAuthenticator = "assist-whatsapp";

// Twilio's limit for one WhatsApp message's text.
const maxMessageLength = 1600;
const idleChatMs = 8 * 60 * 60_000;
const newChatCommand = "/new";
const newChatReply = "Started a new chat. What can I help with?";
const limitReply =
  "That's the limit for now: 30 messages an hour and 200 a day. Try again later.";

const channel = twilioChannel({
  // Every verified sender reaches onText, which answers listed members only:
  // anyone else gets an empty reply and reaches nothing.
  allowFrom: "*",
  credentials: {
    accountSid: () => required(env.TWILIO_ACCOUNT_SID, "TWILIO_ACCOUNT_SID"),
    authToken: () => required(env.TWILIO_AUTH_TOKEN, "TWILIO_AUTH_TOKEN"),
  },
  events: {
    async "call.settled"(event, ctx) {
      const message = sendMessageToolResultSchema.safeParse(
        settledToolResult(event, ctx.view)
      );
      if (!message.success) return;
      if (
        !listedForChatMember(ctx.channel.twilio, ctx.session.auth.initiator)
      ) {
        console.warn(
          "[whatsapp] the chat's number is no longer listed for its member; the reply is not sent"
        );
        return;
      }
      await deliver(ctx.channel.twilio, message.data.output);
    },
    // A reply reaches WhatsApp only through send_message, so the model's own
    // text is never posted.
    // oxlint-disable-next-line eslint/no-empty-function -- Overriding the built-in handler suppresses automatic reply posting.
    async "content.completed"() {},
  },
  messaging: { from: env.TWILIO_WHATSAPP_FROM },
  onText: (ctx, message) => admit(ctx.twilio, message),
  // WhatsApp brings no calls: a call, or a transcript, reaches nobody.
  onVoice: () => null,
  onVoiceTranscription: () => null,
  route,
  webhookUrl: publicWebhookUrl,
});

// Unset, every webhook is refused before anything reads it. A message the
// messages route dispatches goes to its member's current chat on that number,
// which /new and a long silence replace.
export default {
  ...channel,
  // oxlint-disable-next-line oxc/no-map-spread -- Keep eve's original route definitions intact when adding the closed check.
  routes: channel.routes.map((definition) => {
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
    };
  }),
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

// Decides whether a verified message reaches the agent, and as whom. Only a
// WhatsApp message to the configured number from a listed member does, once
// per message id, while the member can still sign in to assist, and within
// their limits. Only such a member is counted, or ever told of the limit.
async function admit(
  twilio: TwilioHandle,
  message: TwilioTextMessage
): Promise<TwilioInboundResult> {
  const sender = whatsappNumberOf(message.from);
  if (!sender || message.to !== env.TWILIO_WHATSAPP_FROM) return null;
  const email = memberEmailOf(sender);
  if (!email) return null;
  if (!message.messageSid || !firstArrival(message.messageSid)) return null;
  // Taken before the first await, so the sender's messages keep the order in
  // which they reach this point.
  const turn = takeTurn(sender);
  let handedOn = false;
  try {
    const userId = await enrolledTeamMemberId(email);
    if (!userId) {
      console.warn("[whatsapp] a listed member cannot sign in; ignoring");
      return null;
    }
    if (!claimMessage(sender).ok) {
      await tellLimitOnce(twilio, sender);
      return null;
    }
    handOn(message.messageSid, {
      newChat: isNewChatCommand(message) ? twilio : undefined,
      turn,
    });
    handedOn = true;
    return { auth: whatsappPrincipal(userId, email) };
  } finally {
    if (!handedOn) turn.release();
  }
}

const whatsappAddressPattern = /^whatsapp:(\+[1-9]\d{6,14})$/u;

function whatsappNumberOf(address: string) {
  return whatsappAddressPattern.exec(address)?.[1];
}

function isNewChatCommand(message: TwilioTextMessage) {
  return (
    (message.media ?? []).length === 0 &&
    message.body.trim().toLowerCase() === newChatCommand
  );
}

function whatsappPrincipal(userId: string, email: string) {
  const scope = accessScopeForUser(`better-auth:${userId}`);
  return {
    attributes: {
      conversationChannel: "whatsapp",
      email,
      workspaceId: scope.workspaceId,
    },
    authenticator: whatsappAuthenticator,
    principalId: scope.userId,
    principalType: "user",
  } satisfies SessionAuthContext;
}

// ASSIST_WHATSAPP_NUMBERS maps each member's number to their assist email:
// "+15551234567=member@example.com,...". It is read on every webhook. An
// entry that does not parse is skipped, and a number listed for two emails
// reaches nobody; each problem is logged once, values never.
const numberEntrySchema = z
  .string()
  .transform((entry) => entry.split("="))
  .pipe(
    z.tuple([
      z
        .string()
        .trim()
        .regex(/^\+[1-9]\d{6,14}$/u),
      z.string().trim().toLowerCase().pipe(z.email()),
    ])
  );

function memberEmailOf(sender: string) {
  const emails = new Set<string>();
  for (const entry of whatsappNumbersVariable().split(",")) {
    if (entry.trim() === "") continue;
    const parsed = numberEntrySchema.safeParse(entry);
    if (!parsed.success) {
      reportOnce(
        "An ASSIST_WHATSAPP_NUMBERS entry is not +<number>=<email>; it is skipped."
      );
      continue;
    }
    const [number, email] = parsed.data;
    if (number === sender) emails.add(email);
  }
  if (emails.size > 1) {
    reportOnce(
      "ASSIST_WHATSAPP_NUMBERS lists a number for two emails; it reaches nobody."
    );
    return undefined;
  }
  return [...emails][0];
}

// A chat's reply goes to its number only while that number is still listed
// for the member whose chat it is, so a number given to someone else never
// receives the earlier member's replies, even from a turn sent on the web.
// eve's own prompts and notices (ask_question's options, a failed turn's
// notice) do not pass here: eve does not export them to wrap.
function listedForChatMember(
  twilio: TwilioHandle,
  initiator: SessionAuthContext | null
) {
  const number = whatsappNumberOf(twilio.from);
  return (
    number !== undefined &&
    initiator?.authenticator === whatsappAuthenticator &&
    memberEmailOf(number) === initiator.attributes.email
  );
}

const reportedProblems = new Set<string>();

function reportOnce(problem: string) {
  if (reportedProblems.has(problem)) return;
  reportedProblems.add(problem);
  console.warn(`[whatsapp] ${problem}`);
}

// Twilio may post a message again when its first post went unanswered; the
// last 1,000 message ids are remembered, in memory, so each one reaches the
// agent once. The service runs one replica.
const maxRememberedMessages = 1000;
const arrivedMessages = new Set<string>();

function firstArrival(messageSid: string) {
  if (arrivedMessages.has(messageSid)) return false;
  arrivedMessages.add(messageSid);
  for (const oldest of arrivedMessages) {
    if (arrivedMessages.size <= maxRememberedMessages) break;
    arrivedMessages.delete(oldest);
  }
  return true;
}

// Each message spends model time, so a number is capped: 30 messages in any
// hour and 200 in any day, /new included. Memory holds the count; a restart
// forgets it.
const messageWindows = [
  { max: 30, ms: 60 * 60_000 },
  { max: 200, ms: 24 * 60 * 60_000 },
] as const;
const recentMessages = new Map<string, number[]>();

// Synchronous, so concurrent webhooks cannot all take the last slot.
function claimMessage(sender: string) {
  const now = Date.now();
  const longest = Math.max(...messageWindows.map(({ ms }) => ms));
  const times = (recentMessages.get(sender) ?? []).filter(
    (at) => at > now - longest
  );
  recentMessages.set(sender, times);
  for (const { max, ms } of messageWindows) {
    if (times.filter((at) => at > now - ms).length >= max) {
      return { ok: false as const };
    }
  }
  times.push(now);
  return { ok: true as const };
}

// A member over the limit is told once an hour, and their messages are
// dropped meanwhile.
const limitNoticeMs = 60 * 60_000;
const limitNotices = new Map<string, number>();

async function tellLimitOnce(twilio: TwilioHandle, sender: string) {
  const now = Date.now();
  if (now - (limitNotices.get(sender) ?? 0) < limitNoticeMs) return;
  limitNotices.set(sender, now);
  try {
    await send(twilio, { Body: limitReply });
  } catch (error) {
    console.warn("[whatsapp] the limit notice could not be sent", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// A sender's messages reach their chat one at a time, in the order they reach
// admit, which is after eve's signature check; Twilio itself promises no
// order. Each message takes its turn there, before any await, and waits for
// the turn before it to settle, so a message right after /new or a long
// silence cannot reach the chat being ended, or end the new one. The service
// runs one replica, so memory holds the queue: its last turn for each listed
// number, since only those take one.
const senderQueues = new Map<string, Promise<unknown>>();

function takeTurn(sender: string) {
  const previous = senderQueues.get(sender) ?? Promise.resolve();
  const settled = Promise.withResolvers<undefined>();
  senderQueues.set(sender, Promise.all([previous, settled.promise]));
  return {
    previous,
    release: () => {
      settled.resolve(undefined);
    },
  };
}

// The messages admit let through that their chat has not yet taken, by
// message id: each one's turn and, for /new, the conversation to confirm it
// in. eve hands an admitted message to its chat at once; one it never hands
// on gives its turn up after 10 seconds, so it cannot hold up the sender's
// later messages.
const unclaimedTurnMs = 10_000;
const admittedMessages = new Map<
  string,
  {
    readonly newChat: TwilioHandle | undefined;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly turn: ReturnType<typeof takeTurn>;
  }
>();

function handOn(
  messageSid: string,
  admitted: {
    readonly newChat: TwilioHandle | undefined;
    readonly turn: ReturnType<typeof takeTurn>;
  }
) {
  const timer = setTimeout(() => {
    claimAdmitted(messageSid)?.turn.release();
  }, unclaimedTurnMs);
  admittedMessages.set(messageSid, { ...admitted, timer });
}

function claimAdmitted(messageSid: string | null | undefined) {
  const admitted = messageSid ? admittedMessages.get(messageSid) : undefined;
  if (!messageSid || !admitted) return undefined;
  admittedMessages.delete(messageSid);
  clearTimeout(admitted.timer);
  return admitted;
}

// One chat per member and number. /new ends it and starts nothing, and a
// message more than 8 hours after the chat's last activity starts a new one;
// eve keeps the address, so the next message after an end starts a fresh
// session there. Only send is used on the messages route.
function chatSessions(
  args: RouteHandlerArgs<TwilioChannelState>
): ChannelFrom<TwilioChannelState> {
  return (address) => ({
    ...args.from(address),
    async send(message, options) {
      const admitted = claimAdmitted(options.state?.lastMessageSid);
      await admitted?.turn.previous;
      try {
        const chat = memberChat(address, options.auth);
        const source = args.from(chat);
        if (admitted?.newChat) {
          const ended = await endChat(source, "The member started a new chat.");
          await send(admitted.newChat, { Body: newChatReply });
          return ended;
        }
        if (await idleTooLong(args, chat)) {
          await endChat(source, "The chat was idle for 8 hours.");
        }
        return await source.send(message, options);
      } finally {
        admitted?.turn.release();
      }
    },
  });
}

// The chat's address joins the member to the number: a number later listed
// for someone else starts a chat of theirs, and never reaches the earlier
// member's.
function memberChat(address: string, auth: SessionAuthContext | null) {
  if (!auth) throw new Error("A WhatsApp message reached its chat unadmitted.");
  return `${address}|${auth.principalId}`;
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

// Sends one reply: its text in parts of at most 1,600 characters, then each
// attachment as a message of its own, since a WhatsApp message carries at
// most one media item.
async function deliver(
  twilio: TwilioHandle,
  reply: z.infer<typeof sendMessageToolResultSchema>["output"]
) {
  if (reply.kind === "link") {
    await send(twilio, { Body: reply.url });
    return;
  }
  for (const part of messageParts(reply.text ?? "")) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The parts must arrive in order.
    await send(twilio, { Body: part });
  }
  for (const { url } of reply.attachments ?? []) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The attachments must arrive in order.
    await send(twilio, { MediaUrl: url });
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
async function send(
  twilio: TwilioHandle,
  content: { readonly Body: string } | { readonly MediaUrl: string }
) {
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
