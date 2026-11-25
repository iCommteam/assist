import {
  allWhatsappLinks,
  deleteWhatsappLink,
  linkedWhatsappMemberOf,
  linkedWhatsappNumberOf,
} from "@db/services/whatsapp-links";
import {
  listedWhatsappMembers,
  numbersOfMember,
  whatsappListingOf,
} from "@shared/environment/whatsapp";

// Who a WhatsApp number reaches, and the numbers that reach a member, read
// again wherever it matters: ASSIST_WHATSAPP_NUMBERS first, as the
// operator's override, then the numbers members linked themselves
// (db/services/whatsapp-links.ts). A number on the list always reaches its
// listed email, or nobody when it is listed for two, and a link for it is
// ignored. Emails come back lower-case, as the list's do, since every
// comparison is exact.
// A link to a number the list gives to someone else, or to nobody, is
// deleted where it meets the list: a message from that number, and the
// Workspace page's reads below. The list took the number, so the link must
// not come back once the entry goes. A member's own link to a number the
// list gives them is kept, and counts again once the entry goes.

function lowerCase(email: string) {
  return email.trim().toLowerCase();
}

function overridden(phone: string, email: string) {
  const listing = whatsappListingOf(phone);
  return listing !== undefined && listing.email !== lowerCase(email);
}

// The member a number reaches, and whether the operator or the member set
// it. A listed number's email is undefined when it reaches nobody.
export async function whatsappOwnerOf(number: string) {
  const listing = whatsappListingOf(number);
  if (listing) return { email: listing.email, source: "server" as const };
  const linked = await linkedWhatsappMemberOf(number);
  if (!linked) return undefined;
  return { email: lowerCase(linked.email), source: "linked" as const };
}

// The assist email a number reaches, or undefined.
export async function whatsappEmailOf(number: string) {
  return (await whatsappOwnerOf(number))?.email;
}

// For a message from a listed number: deletes another member's link to it.
export async function dropOverriddenWhatsappLink(number: string) {
  if (!whatsappListingOf(number)) return;
  const linked = await linkedWhatsappMemberOf(number);
  if (linked && overridden(number, linked.email)) {
    await deleteWhatsappLink(linked.id, linked.userId);
  }
}

// The numbers that reach this email: its listed ones, then the one its
// member linked.
export async function whatsappNumbersOf(email: string) {
  const listed = numbersOfMember(email).map((number) => ({
    id: null,
    linkedAt: null,
    number,
    source: "server" as const,
  }));
  const linked = await linkedWhatsappNumberOf(email);
  if (!linked) return listed;
  if (whatsappListingOf(linked.phone)) {
    if (overridden(linked.phone, email)) {
      await deleteWhatsappLink(linked.id, linked.userId);
    }
    return listed;
  }
  return [
    ...listed,
    {
      id: linked.id,
      linkedAt: linked.linkedAt,
      number: linked.phone,
      source: "linked" as const,
    },
  ];
}

// Every number that reaches a member, for an administrator: the listed ones,
// then the linked ones the list does not override.
export async function connectedWhatsappNumbers() {
  const listed = listedWhatsappMembers().map(({ email, number }) => ({
    email,
    id: null,
    linkedAt: null,
    number,
    source: "server" as const,
  }));
  const links = await allWhatsappLinks();
  await Promise.all(
    links
      .filter((link) => overridden(link.phone, link.email))
      .map(async (link) => deleteWhatsappLink(link.id, link.userId))
  );
  const linked = links
    .filter((link) => !whatsappListingOf(link.phone))
    .map((link) => ({
      email: lowerCase(link.email),
      id: link.id,
      linkedAt: link.linkedAt,
      number: link.phone,
      source: "linked" as const,
    }));
  return [...listed, ...linked];
}
