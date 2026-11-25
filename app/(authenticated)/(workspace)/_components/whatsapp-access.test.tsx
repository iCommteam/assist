import { TRPCClientError } from "@trpc/client";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DialogModule from "@web/components/ui/dialog";
import type { AppRouter } from "@web/trpc/router";

type OpenChange = ComponentProps<typeof DialogModule.Dialog>["onOpenChange"];

interface DisconnectOptions {
  readonly onError?: (error: TRPCClientError<AppRouter>) => void;
}

// What the section handed the Disconnect dialog and its mutation, so a test
// can answer for them as the browser and the server would.
const seen = vi.hoisted(() => ({
  // SAFETY: The mocked mutation records the section's options as it renders.
  disconnectOptions: undefined as DisconnectOptions | undefined,
  // SAFETY: The mocked dialog records the section's handler as it renders.
  onOpenChange: undefined as OpenChange,
  refresh: vi.fn<() => void>(),
  reset: vi.fn<() => void>(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: seen.refresh }),
}));
vi.mock("@web/trpc/client", () => {
  const result = () => ({
    isError: false,
    isPending: false,
    mutate: vi.fn<() => void>(),
    reset: seen.reset,
  });
  const mutation = { useMutation: result };
  return {
    api: {
      useUtils: () => ({
        whatsapp: { linkStatus: { reset: vi.fn<() => Promise<void>>() } },
      }),
      whatsapp: {
        cancelLinkCode: mutation,
        disconnect: {
          useMutation: (options: DisconnectOptions) => {
            seen.disconnectOptions = options;
            return result();
          },
        },
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
vi.mock(import("@web/components/ui/dialog"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    Dialog: (props: ComponentProps<typeof DialogModule.Dialog>) => {
      seen.onOpenChange = props.onOpenChange;
      return createElement(original.Dialog, props);
    },
  };
});

import { WhatsappAccess } from "./whatsapp-access";

beforeEach(() => {
  vi.clearAllMocks();
  seen.disconnectOptions = undefined;
  seen.onOpenChange = undefined;
});

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
    expect(html).toContain("Connected since Nov 25, 2026");
    expect(html).not.toContain("Linked");
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

  it("says WhatsApp is locked before any number is connected, and promises nothing that is off", () => {
    const self = render({ lockedSelf: true });

    expect(self).toContain("Connect WhatsApp");
    expect(self).toContain("Message assist from your phone.");
    expect(self).not.toContain("vault links and your saved notes");
    expect(self).toContain("Your WhatsApp chats are narrow");
    expect(self).toContain("Turn back on");

    const everyone = render({ lockedEveryone: true });

    expect(everyone).not.toContain("vault links and your saved notes");
    expect(everyone).toContain(
      "An administrator locked WhatsApp for everyone: chats there are narrow until an administrator turns it back on."
    );
    expect(everyone).not.toContain(">Lock<");
  });

  it("tells an administrator what Lock everyone has locked, with no number of their own", () => {
    const html = render({ admin: true, lockedEveryone: true });

    expect(html).toContain("Turn everyone back on");
    expect(html).toMatch(
      /Everyone(&#x27;|')s WhatsApp is locked: chats there are narrow until you turn everyone back on\./u
    );
  });
});

describe("Disconnect", () => {
  function renderLinked() {
    return render({
      numbers: [
        { id: linkId, number: "+972 53 564 2199", since: "Nov 25, 2026" },
      ],
    });
  }

  it("closes and loads the page again when the number is no longer there to disconnect", () => {
    renderLinked();

    seen.disconnectOptions?.onError?.(
      TRPCClientError.from<AppRouter>({
        error: {
          code: -32_004,
          data: { code: "NOT_FOUND", httpStatus: 404 },
          message: "NOT_FOUND",
        },
      })
    );

    expect(seen.refresh).toHaveBeenCalledOnce();
  });

  it("keeps the dialog for any other failure, so the member can try again", () => {
    renderLinked();

    seen.disconnectOptions?.onError?.(
      TRPCClientError.from<AppRouter>({
        error: {
          code: -32_603,
          data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
          message: "The request failed.",
        },
      })
    );

    expect(seen.refresh).not.toHaveBeenCalled();
  });

  it("clears an earlier failure each time the dialog opens", () => {
    renderLinked();

    // SAFETY: The section's handler reads only whether the dialog opens.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Static markup has no event to pass.
    seen.onOpenChange?.(true, {} as never);

    expect(seen.reset).toHaveBeenCalledOnce();
  });
});
