import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { encode } from "uqr";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn<() => void>() }),
}));
vi.mock("@web/trpc/client", () => ({ api: {} }));

import { LinkCodeCard } from "./whatsapp-link";

const link = "https://wa.me/972535642199?text=link%20ABCD2345";

function render(expired: boolean) {
  return renderToStaticMarkup(
    createElement(LinkCodeCard, {
      code: "ABCD2345",
      expired,
      expiresAt: "2026-11-25T12:10:00.000Z",
      failed: false,
      onCancel: vi.fn<() => void>(),
      onNewCode: vi.fn<() => void>(),
      pending: false,
      sender: { digits: "972535642199", number: "+972 53 564 2199" },
    })
  );
}

describe("the link code card", () => {
  it("shows a QR code and a button for the wa.me link, and the code to send by hand", () => {
    const html = render(false);
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
    expect(html).toContain("Waiting for your message. The code works until");
    expect(html).toContain("New code");
    expect(html).toContain("Cancel");
  });

  it("says when the code expired and offers a new one, with nothing left to send", () => {
    const html = render(true);

    expect(html).toContain("This code expired");
    expect(html).toContain("New code");
    expect(html).not.toContain("viewBox");
    expect(html).not.toContain("wa.me");
    expect(html).not.toContain("ABCD2345");
  });
});
