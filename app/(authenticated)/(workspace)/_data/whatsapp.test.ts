import { beforeEach, describe, expect, it, vi } from "vitest";
import type { isAdminMember } from "@db/services/auth/allowlist";
import type { getAuthSession } from "@db/services/auth/session";
import type { whatsappLockOf } from "@db/services/whatsapp";
import type {
  connectedWhatsappNumbers,
  whatsappNumbersOf,
} from "@db/services/whatsapp-numbers";
import { authSessionFor } from "@tests/helpers/auth-session";

const mocks = vi.hoisted(() => ({
  configured: true,
  connectedWhatsappNumbers: vi.fn<typeof connectedWhatsappNumbers>(),
  getAuthSession: vi.fn<typeof getAuthSession>(),
  isAdminMember: vi.fn<typeof isAdminMember>(),
  whatsappLockOf: vi.fn<typeof whatsappLockOf>(),
  whatsappNumbersOf: vi.fn<typeof whatsappNumbersOf>(),
}));

vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@db/services/auth/session", () => ({
  getAuthSession: mocks.getAuthSession,
}));
vi.mock("@db/services/auth/allowlist", () => ({
  isAdminMember: mocks.isAdminMember,
}));
vi.mock("@db/services/whatsapp", () => ({
  whatsappLockOf: mocks.whatsappLockOf,
}));
vi.mock("@db/services/whatsapp-numbers", () => ({
  connectedWhatsappNumbers: mocks.connectedWhatsappNumbers,
  whatsappNumbersOf: mocks.whatsappNumbersOf,
}));
vi.mock("@shared/environment", () => ({
  env: { TWILIO_WHATSAPP_FROM: "whatsapp:+972535642199" },
}));
vi.mock("@shared/environment/whatsapp", () => ({
  whatsappChannelConfigured: () => mocks.configured,
}));

import { displayNumber, maskedNumber, whatsappSection } from "./whatsapp";

const linkedAt = new Date("2026-11-25T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured = true;
  mocks.getAuthSession.mockResolvedValue(
    authSessionFor({ email: "member@example.test", id: "user-1" })
  );
  mocks.isAdminMember.mockResolvedValue(false);
  mocks.whatsappLockOf.mockResolvedValue({ everyone: false, self: false });
  mocks.whatsappNumbersOf.mockResolvedValue([]);
  mocks.connectedWhatsappNumbers.mockResolvedValue([]);
});

describe("the Workspace page's WhatsApp section", () => {
  it("shows to every signed-in member while the channel is configured, with the company's number", async () => {
    await expect(whatsappSection()).resolves.toEqual({
      admin: false,
      connected: [],
      lockedEveryone: false,
      lockedSelf: false,
      numbers: [],
      sender: { digits: "972535642199", number: "+972 53 564 2199" },
    });
    expect(mocks.whatsappNumbersOf).toHaveBeenCalledWith("member@example.test");
    expect(mocks.connectedWhatsappNumbers).not.toHaveBeenCalled();
  });

  it("shows nothing while the channel is closed, or to nobody signed in", async () => {
    mocks.configured = false;
    await expect(whatsappSection()).resolves.toBeUndefined();

    mocks.configured = true;
    mocks.getAuthSession.mockResolvedValue(null);
    await expect(whatsappSection()).resolves.toBeUndefined();
  });

  it("gives the member their own numbers in full, and an administrator everyone's partly hidden", async () => {
    mocks.isAdminMember.mockResolvedValue(true);
    mocks.whatsappNumbersOf.mockResolvedValue([
      { id: null, linkedAt: null, number: "+15550000001", source: "server" },
    ]);
    mocks.connectedWhatsappNumbers.mockResolvedValue([
      {
        email: "member@example.test",
        id: null,
        linkedAt: null,
        number: "+15550000001",
        source: "server",
      },
      {
        email: "other@example.test",
        id: "00000000-0000-4000-8000-000000000001",
        linkedAt,
        number: "+972535642100",
        source: "linked",
      },
    ]);

    const section = await whatsappSection();

    expect(section?.numbers).toEqual([
      { id: null, number: "+1 555 000 0001", since: null },
    ]);
    expect(section?.connected).toEqual([
      {
        email: "member@example.test",
        id: null,
        key: "server-0",
        number: "+1 ••• 0001",
        since: null,
      },
      {
        email: "other@example.test",
        id: "00000000-0000-4000-8000-000000000001",
        key: "00000000-0000-4000-8000-000000000001",
        number: "+972 ••• 2100",
        since: "Nov 25, 2026",
      },
    ]);
    expect(JSON.stringify(section?.connected)).not.toContain("535642100");
  });
});

describe("WhatsApp numbers as people read them", () => {
  it("groups Israeli and North American numbers, and leaves any other as it is", () => {
    expect(displayNumber("+972535642199")).toBe("+972 53 564 2199");
    expect(displayNumber("+14155238886")).toBe("+1 415 523 8886");
    expect(displayNumber("+447700900123")).toBe("+447700900123");
    expect(displayNumber("+97231234567")).toBe("+97231234567");
  });

  it("hides all but the country and the last four digits", () => {
    expect(maskedNumber("+972535642199")).toBe("+972 ••• 2199");
    expect(maskedNumber("+14155238886")).toBe("+1 ••• 8886");
    expect(maskedNumber("+447700900123")).toBe("+44 ••• 0123");
  });
});
