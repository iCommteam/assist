import { headers } from "next/headers";
import { isAdminMember } from "@db/services/auth/allowlist";
import { getAuthSession } from "@db/services/auth/session";
import { whatsappLockOf } from "@db/services/whatsapp";
import {
  connectedWhatsappNumbers,
  whatsappNumbersOf,
} from "@db/services/whatsapp-numbers";
import { env } from "@shared/environment";
import { whatsappChannelConfigured } from "@shared/environment/whatsapp";

// The WhatsApp section of the Workspace page, for every signed-in member
// while the channel is configured: their own numbers in full, and for an
// administrator every connected number, partly hidden. Read on every view.
export async function whatsappSection() {
  const from = env.TWILIO_WHATSAPP_FROM?.slice("whatsapp:".length);
  if (!whatsappChannelConfigured() || from === undefined) return undefined;
  const session = await getAuthSession(await headers());
  if (!session) return undefined;
  const [numbers, admin, lock] = await Promise.all([
    whatsappNumbersOf(session.user.email),
    isAdminMember(session.user.id),
    whatsappLockOf(session.user.id),
  ]);
  const connected = admin ? await connectedWhatsappNumbers() : [];
  return {
    admin,
    connected: connected.map((entry, index) => ({
      email: entry.email,
      id: entry.id,
      key: entry.id ?? `server-${String(index)}`,
      number: maskedNumber(entry.number),
      since: entry.linkedAt === null ? null : dateLabel(entry.linkedAt),
    })),
    lockedEveryone: lock.everyone,
    lockedSelf: lock.self,
    numbers: numbers.map((entry) => ({
      id: entry.id,
      number: displayNumber(entry.number),
      since: entry.linkedAt === null ? null : dateLabel(entry.linkedAt),
    })),
    sender: { digits: from.slice(1), number: displayNumber(from) },
  };
}

// The countries whose numbers are grouped as people write them; any other
// number shows as its plain E.164 form.
const numberGroups = [
  { groups: [2, 3, 4], prefix: "+972" },
  { groups: [3, 3, 4], prefix: "+1" },
] as const;

// +972535642199 as +972 53 564 2199.
export function displayNumber(number: string) {
  for (const { groups, prefix } of numberGroups) {
    const rest = number.slice(prefix.length);
    const length = groups.reduce((total, size) => total + size, 0);
    if (!number.startsWith(prefix) || rest.length !== length) continue;
    const parts: string[] = [prefix];
    let at = 0;
    for (const size of groups) {
      parts.push(rest.slice(at, at + size));
      at += size;
    }
    return parts.join(" ");
  }
  return number;
}

// Another member's number with only its last four digits shown, after its
// country code when it is one of the countries above: a guessed prefix could
// show a digit of the number itself.
export function maskedNumber(number: string) {
  const prefix =
    numberGroups.find((country) => number.startsWith(country.prefix))?.prefix ??
    "+";
  return `${prefix} ••• ${number.slice(-4)}`;
}

// In the team's own zone, whatever zone the server runs in.
function dateLabel(date: Date) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Jerusalem",
    year: "numeric",
  }).format(date);
}
