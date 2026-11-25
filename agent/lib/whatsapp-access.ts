import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { enrolledTeamMemberId } from "@db/services/auth/allowlist";
import { whatsappChatOfSession, whatsappLockOf } from "@db/services/whatsapp";
import { memberEmailOf, numbersOfMember } from "@shared/environment/whatsapp";
import { accessScopeForUser } from "@shared/identity/access-scope";

// Who may use assist on WhatsApp, and how much of it, read again wherever it
// matters: the channel on every message and reply, and the hooks of the root
// agent and the browser worker before every turn, model call and tool call.
// A listed member who can sign in gets full access until they lock it; a
// locked member keeps the narrow chat.

// The authenticator of a WhatsApp session's principal, which decides its
// mode (agent/lib/mode.ts).
const whatsappAuthenticator = "assist-whatsapp";

const whatsappAddressPattern = /^whatsapp:(\+[1-9]\d{6,14})$/u;

// The E.164 number of a Twilio WhatsApp address, such as whatsapp:+1555...
export function whatsappNumberOf(address: string) {
  return whatsappAddressPattern.exec(address)?.[1];
}

// Whether any number still reaches this email.
function emailIsListed(email: string) {
  return numbersOfMember(email).length > 0;
}

// The principal a listed member's WhatsApp messages run as. The narrow chat's
// is exactly the one every chat had before full access, so a locked member's
// chats carry on; the full chat's names its access and its number.
export function whatsappPrincipal(
  userId: string,
  email: string,
  access:
    | { readonly level: "narrow" }
    | { readonly level: "full"; readonly number: string }
) {
  const scope = accessScopeForUser(`better-auth:${userId}`);
  const attributes = new Map([
    ["conversationChannel", "whatsapp"],
    ["email", email],
    ["workspaceId", scope.workspaceId],
  ]);
  if (access.level === "full") {
    attributes.set("whatsappAccess", "full");
    attributes.set("whatsappNumber", access.number);
  }
  return {
    attributes: Object.fromEntries(attributes),
    authenticator: whatsappAuthenticator,
    principalId: scope.userId,
    principalType: "user",
  } satisfies SessionAuthContext;
}

const sessionAttributesSchema = z.object({
  email: z.email(),
  whatsappAccess: z.literal("full").optional(),
  whatsappNumber: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/u)
    .optional(),
});

// The member and level of a WhatsApp session, from its initiator; undefined
// for every other session.
export function whatsappSessionOf(initiator: SessionAuthContext | null) {
  if (initiator?.authenticator !== whatsappAuthenticator) return undefined;
  const attributes = sessionAttributesSchema.safeParse(initiator.attributes);
  const principalId = initiator.principalId;
  if (!attributes.success || !principalId.startsWith("better-auth:")) {
    return undefined;
  }
  const { email, whatsappAccess, whatsappNumber } = attributes.data;
  return whatsappAccess === "full" && whatsappNumber !== undefined
    ? { email, level: "full" as const, number: whatsappNumber, principalId }
    : { email, level: "narrow" as const, principalId };
}

// What the member may have on WhatsApp right now: "full" while their number
// is listed for them, they can sign in and nobody locked it; "narrow" when it
// is locked; "none" when the number, or for a chat that names none any
// number, no longer reaches them, or they can no longer sign in.
export async function whatsappAccessOf(member: {
  readonly email: string;
  readonly number?: string;
  readonly principalId: string;
}) {
  const listed =
    member.number === undefined
      ? emailIsListed(member.email)
      : memberEmailOf(member.number) === member.email;
  if (!listed) return "none" as const;
  const userId = member.principalId.slice("better-auth:".length);
  if ((await enrolledTeamMemberId(member.email)) !== userId) {
    return "none" as const;
  }
  const lock = await whatsappLockOf(userId);
  return lock.self || lock.everyone ? ("narrow" as const) : ("full" as const);
}

// For a delegated session, such as a browser worker: whether its root
// session is a full WhatsApp chat, and if so
// whether that chat still has full access. A worker started by a turn the
// member typed on the web carries the web sign-in, not the WhatsApp
// principal, so the root's chat decides. "unknown" when the chat could not
// be read; undefined for every other root session.
export async function whatsappRootAccessOf(rootSessionId: string) {
  let chat: Awaited<ReturnType<typeof whatsappChatOfSession>>;
  try {
    chat = await whatsappChatOfSession(rootSessionId);
  } catch {
    return "unknown" as const;
  }
  if (!chat) return undefined;
  if (chat.endedAt !== null) return { chat, level: "off" as const };
  try {
    const access = await whatsappAccessOf({
      email: chat.email,
      number: chat.phone,
      principalId: chat.userId,
    });
    return {
      chat,
      level: access === "full" ? ("full" as const) : ("off" as const),
    };
  } catch {
    return { chat, level: "off" as const };
  }
}

// Why an access hook cancelled a WhatsApp turn, when the member should hear
// it: the channel posts the notice when the turn settles, through the same
// gate as replies. Hooks and the channel run in the eve server's one process;
// a restart forgets a notice not yet posted.
const cancelNotices = new Map<string, string>();
const maxCancelNotices = 200;

export function noteWhatsappCancel(
  sessionId: string,
  turnId: string | undefined,
  notice: string
) {
  if (turnId === undefined) return;
  cancelNotices.set(`${sessionId}:${turnId}`, notice);
  for (const oldest of cancelNotices.keys()) {
    if (cancelNotices.size <= maxCancelNotices) break;
    cancelNotices.delete(oldest);
  }
}

export function takeWhatsappCancelNotice(sessionId: string, turnId: string) {
  const key = `${sessionId}:${turnId}`;
  const notice = cancelNotices.get(key);
  cancelNotices.delete(key);
  return notice;
}
