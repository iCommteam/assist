import {
  allWhatsappLinks,
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

// The member a number reaches, and whether the operator or the member set
// it. A listed number's email is undefined when it reaches nobody.
export async function whatsappOwnerOf(number: string) {
  const listing = whatsappListingOf(number);
  if (listing) return { email: listing.email, source: "server" as const };
  const linked = await linkedWhatsappMemberOf(number);
  if (!linked) return undefined;
  return {
    email: linked.email.trim().toLowerCase(),
    source: "linked" as const,
  };
}

// The assist email a number reaches, or undefined.
export async function whatsappEmailOf(number: string) {
  return (await whatsappOwnerOf(number))?.email;
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
  if (!linked || whatsappListingOf(linked.phone)) return listed;
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
  const linked = (await allWhatsappLinks())
    .filter((link) => !whatsappListingOf(link.phone))
    .map((link) => ({
      email: link.email.trim().toLowerCase(),
      id: link.id,
      linkedAt: link.linkedAt,
      number: link.phone,
      source: "linked" as const,
    }));
  return [...listed, ...linked];
}
