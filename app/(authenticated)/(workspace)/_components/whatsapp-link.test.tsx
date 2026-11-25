import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { encode } from "uqr";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn<() => void>() }),
}));
vi.mock("@web/trpc/client", () => ({ api: {} }));

import { LinkCodeCard, linkPhase } from "./whatsapp-link";

const link = "https://wa.me/972535642199?text=link%20ABCD2345";
const expiresAt = "2026-11-25T12:10:00.000Z";
const linkId = "00000000-0000-4000-8000-000000000001";

function render(phase: Parameters<typeof LinkCodeCard>[0]["phase"]) {
  return renderToStaticMarkup(
    createElement(LinkCodeCard, {
      code: "ABCD2345",
      expiresAt,
      failed: false,
      onCancel: vi.fn<() => void>(),
      onNewCode: vi.fn<() => void>(),
      pending: false,
      phase,
      sender: { digits: "972535642199", number: "+972 53 564 2199" },
    })
  );
}

// The status region's text, which a screen reader reads out on each change.
function statusOf(html: string) {
  return /<output class="[^"]*">(.*?)<\/output>/u
    .exec(html)?.[1]
    ?.replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function newCodeVariant(html: string) {
  return /data-variant="(\w+)"[^>]*>New code/u.exec(html)?.[1];
}

describe("the link code card", () => {
  it("shows a QR code and a button for the wa.me link, and the code to send by hand", () => {
    const html = render("waiting");
    const { data, size } = encode(link, { border: 2, ecc: "M" });
    const drawn = [...html.matchAll(/h(\d+)v1/gu)].reduce(
      (total, [, width]) => total + Number(width),
      0
    );

    expect(html).toContain(`viewBox="0 0 ${String(size)} ${String(size)}"`);
    expect(drawn).toBe(data.flat().filter(Boolean).length);
    expect(html).toContain(`href="${link}"`);
    expect(html).toContain("Open WhatsApp");
    expect(html).toContain("link ABCD2345");
    expect(html).toContain("+972 53 564 2199");
    expect(statusOf(html)).toMatch(
      /^Send this code on WhatsApp Waiting for your message\. The code works until .+\.$/u
    );
    expect(html).toContain(
      '<p aria-hidden="true" class="type-caption text-muted-foreground">Scan with your phone</p>'
    );
    expect(html).toContain('tabindex="-1"');
    expect(newCodeVariant(html)).toBe("ghost");
    expect(html).toContain("Cancel");
  });

  it("says when the code expired and offers a new one, with nothing left to send", () => {
    const html = render("expired");

    expect(statusOf(html)).toBe(
      "This code expired Codes work for 10 minutes. Get a new one to try again."
    );
    expect(newCodeVariant(html)).toBe("default");
    expect(html).not.toContain("viewBox");
    expect(html).not.toContain("wa.me");
    expect(html).not.toContain("ABCD2345");
  });

  it("says a code used by a message that connected nothing was used, not expired, and leaves WhatsApp's reply to say why", () => {
    const html = render("used");

    expect(statusOf(html)).toBe(
      "This code was used WhatsApp&#x27;s reply says what happened. To try again, get a new code."
    );
    expect(newCodeVariant(html)).toBe("ghost");
    expect(html).not.toContain("expired");
    expect(html).not.toContain("wa.me");
  });

  it("says Connected while the page loads the number, with nothing left to press", () => {
    const html = render("connected");

    expect(statusOf(html)).toBe("Connected Your number now reaches assist.");
    expect(html).not.toContain("New code");
    expect(html).not.toContain("Cancel");
    expect(html).not.toContain("Connect WhatsApp");
  });
});

describe("the link code card's phase", () => {
  const card = { expiresAt, linkedIdAtStart: null };
  const before = Date.parse(expiresAt) - 60_000;
  const after = Date.parse(expiresAt) + 1000;

  it("waits until the first check, and while the code is live", () => {
    expect(linkPhase(undefined, 0, card)).toBe("waiting");
    expect(linkPhase({ codeLive: true, linkedId: null }, before, card)).toBe(
      "waiting"
    );
  });

  it("shows a new link as connected, but not the one the page already showed", () => {
    expect(linkPhase({ codeLive: false, linkedId: linkId }, before, card)).toBe(
      "connected"
    );
    expect(
      linkPhase({ codeLive: false, linkedId: linkId }, before, {
        expiresAt,
        linkedIdAtStart: linkId,
      })
    ).toBe("used");
  });

  it("calls a code gone before its expiry used, and one gone after it expired", () => {
    expect(linkPhase({ codeLive: false, linkedId: null }, before, card)).toBe(
      "used"
    );
    expect(linkPhase({ codeLive: false, linkedId: null }, after, card)).toBe(
      "expired"
    );
  });
});
