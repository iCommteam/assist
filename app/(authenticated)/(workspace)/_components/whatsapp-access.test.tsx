import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn<() => void>() }),
}));
vi.mock("@web/trpc/client", () => {
  const mutation = {
    useMutation: () => ({
      isError: false,
      isPending: false,
      mutate: vi.fn<() => void>(),
    }),
  };
  return {
    api: {
      useUtils: () => ({
        whatsapp: { linkStatus: { reset: vi.fn<() => Promise<void>>() } },
      }),
      whatsapp: {
        cancelLinkCode: mutation,
        disconnect: mutation,
        linkCode: mutation,
        linkStatus: { useQuery: () => ({ data: undefined }) },
        lock: mutation,
        lockEveryone: mutation,
        unlock: mutation,
        unlockEveryone: mutation,
      },
    },
  };
});

import { WhatsappAccess } from "./whatsapp-access";

type Section = Parameters<typeof WhatsappAccess>[0];

const linkId = "00000000-0000-4000-8000-000000000001";

function render(overrides: Partial<Section> = {}) {
  return renderToStaticMarkup(
    createElement(WhatsappAccess, {
      admin: false,
      connected: [],
      lockedEveryone: false,
      lockedSelf: false,
      numbers: [],
      sender: { digits: "972535642199", number: "+972 53 564 2199" },
      ...overrides,
    })
  );
}

describe("the Workspace page's WhatsApp", () => {
  it("offers Connect WhatsApp, with one line on what it gives, while no number reaches the member", () => {
    const html = render();

    expect(html).toContain("Connect WhatsApp");
    expect(html).toContain(
      "Message assist from your phone and it works for you, with the browser, vault links and your saved notes."
    );
    expect(html).not.toContain(">Lock<");
    expect(html).not.toContain("Disconnect");
  });

  it("shows a linked number in full, since when, the lock, and Disconnect", () => {
    const html = render({
      numbers: [
        { id: linkId, number: "+972 53 564 2199", since: "Nov 25, 2026" },
      ],
    });

    expect(html).toContain("+972 53 564 2199");
    expect(html).toContain("Connected since Nov 25, 2026");
    expect(html).toContain("Full access on");
    expect(html).toContain(">Lock<");
    expect(html).toContain('aria-label="Disconnect +972 53 564 2199"');
    expect(html).not.toContain("Connect WhatsApp");
    expect(html).not.toContain("Connect another number");
  });

  it("marks a number the server sets, with no Disconnect, and lets the member connect their own", () => {
    const html = render({
      lockedSelf: true,
      numbers: [{ id: null, number: "+972 53 564 2199", since: null }],
    });

    expect(html).toContain("Set by the server");
    expect(html).toContain("Locked");
    expect(html).toContain("Turn back on");
    expect(html).not.toContain("Disconnect");
    expect(html).toContain("Connect another number");
  });

  it("shows an administrator every connected number, partly hidden, with Disconnect for linked ones and Lock everyone", () => {
    const html = render({
      admin: true,
      connected: [
        {
          email: "vkolek@example.test",
          id: null,
          key: "server-0",
          number: "+972 ••• 2199",
          since: null,
        },
        {
          email: "member@example.test",
          id: linkId,
          key: linkId,
          number: "+1 ••• 0001",
          since: "Nov 25, 2026",
        },
      ],
    });

    expect(html).toMatch(/Everyone(&#x27;|')s numbers/u);
    expect(html).toContain("Lock everyone");
    expect(html).toContain("+972 ••• 2199");
    expect(html).toContain("Set by the server");
    expect(html).toContain("Linked Nov 25, 2026");
    expect(html.match(/aria-label="Disconnect [^"]+number"/gu)).toEqual([
      'aria-label="Disconnect member@example.test&#x27;s number"',
    ]);
    expect(html).toContain("Connect WhatsApp");
  });

  it("shows no one else's numbers to a member who is not an administrator", () => {
    const html = render({
      numbers: [
        { id: linkId, number: "+972 53 564 2199", since: "Nov 25, 2026" },
      ],
    });

    expect(html).not.toMatch(/Everyone(&#x27;|')s numbers/u);
    expect(html).not.toContain("Lock everyone");
  });
});
