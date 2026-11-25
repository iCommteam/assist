import type * as React from "react";
import { Children, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { getAuthSession } from "@db/services/auth/session";
import type {
  googleAccountOf,
  GoogleAccountSummary,
} from "@db/services/connectors/google";
import type { googleOAuthClient } from "@shared/connectors/google/oauth";
import { googleRequestedScopes } from "@shared/connectors/google/scopes";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { authSessionFor } from "@tests/helpers/auth-session";

const mocks = vi.hoisted(() => ({
  account: vi.fn<typeof googleAccountOf>(),
  assign: vi.fn<(url: string) => void>(),
  buttons: new Map<string, (() => void) | undefined>(),
  client: vi.fn<typeof googleOAuthClient>(),
  dialog:
    vi.fn<
      (props: {
        readonly onOpenChange: ((open: boolean) => void) | undefined;
        readonly open: boolean | undefined;
      }) => void
    >(),
  fetch: vi.fn<typeof fetch>(),
  refresh: vi.fn<() => void>(),
  reload: vi.fn<() => void>(),
  replace:
    vi.fn<(href: string, options?: { readonly scroll?: boolean }) => void>(),
  replaceState: vi.fn<(data: null, unused: string, url: URL) => void>(),
  search: { value: "" },
  session: vi.fn<typeof getAuthSession>(),
}));

// The words a button shows, which name its handler for a test to press.
function textOf(children: ReactNode) {
  return Children.toArray(children)
    .flatMap((child) => {
      const text = z.string().safeParse(child);
      return text.success ? [text.data] : [];
    })
    .join("");
}

// A dialog part rendered in place, open or not.
function DialogPart({ children }: { readonly children?: ReactNode }) {
  return <div>{children}</div>;
}

// A static render never runs effects; here each runs at once, as it renders.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useEffect: (effect: React.EffectCallback) => {
    effect();
  },
}));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(mocks.search.value),
}));
vi.mock("@db/services/auth/session", () => ({
  getAuthSession: mocks.session,
}));
vi.mock("@db/services/connectors/google", () => ({
  googleAccountOf: mocks.account,
}));
vi.mock("@shared/connectors/google/oauth", () => ({
  googleOAuthClient: mocks.client,
}));
// Every button keeps its handler, by its words, for a test to press.
vi.mock("@web/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    readonly children?: ReactNode;
    readonly disabled?: boolean;
    readonly onClick?: () => void;
  }) => {
    mocks.buttons.set(textOf(children), onClick);
    return (
      <button disabled={disabled} type="button">
        {children}
      </button>
    );
  },
}));
// The dialog's parts render their content in place, open or not.
vi.mock("@web/components/ui/dialog", () => ({
  Dialog: ({
    children,
    onOpenChange,
    open,
  }: {
    readonly children?: ReactNode;
    readonly onOpenChange?: (open: boolean) => void;
    readonly open?: boolean;
  }) => {
    mocks.dialog({ onOpenChange, open });
    return <div>{children}</div>;
  },
  DialogClose: DialogPart,
  DialogContent: DialogPart,
  DialogDescription: DialogPart,
  DialogFooter: DialogPart,
  DialogHeader: DialogPart,
  DialogTitle: DialogPart,
  DialogTrigger: DialogPart,
}));

const { ConnectorsSection } = await import("../_components/connectors");

const connected: GoogleAccountSummary = {
  connectedAt: "2026-11-25T08:00:00.000Z",
  email: "member@icommteam.com",
  needsReconnect: false,
  scopes: [...googleRequestedScopes],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buttons.clear();
  mocks.search.value = "";
  mocks.session.mockResolvedValue(authSessionFor({ id: "user-1" }));
  mocks.client.mockReturnValue({
    clientId: "client.apps.googleusercontent.com",
    clientSecret: "client-secret",
  });
  mocks.account.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("window", {
    history: { replaceState: mocks.replaceState },
    location: {
      assign: mocks.assign,
      href: "https://assist.example/",
      reload: mocks.reload,
    },
  });
});

async function render() {
  return renderToStaticMarkup(await ConnectorsSection());
}

// Presses the button showing these words, as the member would.
function press(words: string) {
  const handler = mocks.buttons.get(words);
  if (!handler) throw new Error(`Expected a "${words}" button.`);
  handler();
}

// What the proxy gives a POST from a member whose session ended: a redirect
// to the sign-in page, which fetch, told not to follow it, sees as opaque.
function signInRedirect() {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "type", { value: "opaqueredirect" });
  return response;
}

describe("the Workspace page's Connectors", () => {
  it("says an administrator has not set Google up, and offers nothing to press", async () => {
    mocks.client.mockReturnValue(undefined);
    const html = await render();

    expect(html).toContain("Connectors");
    // The whole sentence, which wraps on a phone instead of being cut.
    expect(html).toMatch(
      /<p class="(?![^"]*truncate)[^"]*">An administrator has not set up Google for assist yet\.<\/p>/u
    );
    expect(html).toContain("Not set up");
    expect(html).not.toContain("Connect Google");
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it("offers Connect Google to a member who has not connected", async () => {
    const html = await render();

    expect(html).toContain("Connect Google");
    expect(html).toContain("Gmail, Calendar and Drive, for your own chats.");
    expect(html).not.toContain("Disconnect");
    expect(mocks.account).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:user-1")
    );
  });

  it("shows the connected account, everything Google granted and Disconnect", async () => {
    mocks.account.mockResolvedValue(connected);
    const html = await render();

    expect(html).toContain('title="member@icommteam.com"');
    expect(html).toContain("Connected");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("Connect Google");
    expect(html).not.toContain("Reconnect");
    expect(html.match(/Allowed: /gu)).toHaveLength(5);
    expect(html).toContain("Gmail · Write drafts, and send mail you approve");
    expect(html).not.toContain("To allow what is missing");
  });

  it("gives the text a width of its own, so on a phone the buttons move under it", async () => {
    mocks.account.mockResolvedValue({ ...connected, needsReconnect: true });
    const html = await render();

    const textColumn = /<div class="([^"]*)"><p class="[^"]*type-label/u.exec(
      html
    )?.[1];
    expect(textColumn?.split(" ").toSorted()).toEqual([
      "basis-48",
      "grow",
      "min-w-0",
    ]);
  });

  it("marks what the member unticked on Google's screen, and offers Reconnect to allow it", async () => {
    mocks.account.mockResolvedValue({
      ...connected,
      scopes: connected.scopes.filter(
        (scope) => !scope.endsWith("drive.readonly")
      ),
    });
    const html = await render();

    expect(html).toContain("Limited access");
    expect(html).not.toContain(">Connected<");
    expect(html).toContain(
      "Not allowed: </span>Drive · Search and read files, Docs and Sheets"
    );
    expect(html).toContain(
      "To allow what is missing, press Reconnect and tick it on Google&#x27;s screen."
    );
    expect(mocks.buttons.has("Reconnect")).toBe(true);
    expect(mocks.buttons.has("Disconnect")).toBe(true);
  });

  it("asks a member whose grant Google refused to reconnect, and lists nothing as allowed", async () => {
    mocks.account.mockResolvedValue({ ...connected, needsReconnect: true });
    const html = await render();

    expect(html).toContain("Reconnect needed");
    expect(html).toContain(
      "assist can use none of this account until you reconnect."
    );
    expect(html).not.toContain("Allowed: ");
    expect(mocks.buttons.has("Reconnect")).toBe(true);
    expect(mocks.buttons.has("Disconnect")).toBe(true);
  });
});

describe("how the last connect or disconnect went", () => {
  it("says it once, from the page's address, and takes it off the address", async () => {
    mocks.search.value = "google=denied";
    Object.assign(window.location, {
      href: "https://assist.example/?google=denied&tab=1#connectors",
    });

    expect(await render()).toContain("Google access was not granted");
    const [, , url] = mocks.replaceState.mock.calls[0] ?? [];
    expect(url?.toString()).toBe("https://assist.example/?tab=1#connectors");

    mocks.replaceState.mockClear();
    mocks.search.value = "google=unknown";
    expect(await render()).not.toContain('role="alert"');
    expect(mocks.replaceState).not.toHaveBeenCalled();
  });

  it("names no button the row may not show, and says when Google allowed only part, or nothing", async () => {
    // A member with Reconnect needed sees these too, and has no Connect
    // Google button.
    for (const [outcome, expected] of Object.entries({
      denied: "Nothing was connected. You can try again here.",
      expired: "Nothing was connected. You can start again here.",
      failed: "Nothing was connected. You can try again here.",
    })) {
      mocks.search.value = `google=${outcome}`;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each outcome is rendered on its own.
      const html = await render();
      const said = /data-slot="alert-description"[^>]*>([^<]*)</u.exec(
        html
      )?.[1];
      expect({ outcome, said }).toEqual({ outcome, said: expected });
    }
    mocks.search.value = "google=partial";
    expect(await render()).toContain("Google connected, with limited access");
    mocks.search.value = "google=nothing-allowed";
    expect(await render()).toContain("Nothing was allowed");
  });
});

describe("pressing Connect Google", () => {
  it("opens Google's consent screen", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth" })
    );
    await render();
    press("Connect Google");

    await vi.waitFor(() => {
      expect(mocks.assign).toHaveBeenCalledWith(
        "https://accounts.google.com/o/oauth2/v2/auth"
      );
    });
    expect(mocks.fetch).toHaveBeenCalledWith("/api/connectors/google/start", {
      method: "POST",
      redirect: "manual",
    });
  });

  it("sends a member whose session ended to sign in, instead of asking them to try again", async () => {
    mocks.fetch.mockResolvedValue(signInRedirect());
    await render();
    press("Connect Google");

    await vi.waitFor(() => {
      expect(mocks.reload).toHaveBeenCalledOnce();
    });
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("shows that Google is not set up when an administrator removed it meanwhile", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ error: "unavailable" }, { status: 409 })
    );
    await render();
    press("Connect Google");

    await vi.waitFor(() => {
      expect(mocks.refresh).toHaveBeenCalledOnce();
    });
    expect(mocks.replace).toHaveBeenCalledWith(
      "/?google=unavailable#connectors",
      { scroll: false }
    );
  });
});

describe("pressing Disconnect", () => {
  it("closes the dialog and reloads the section in place, whatever the address", async () => {
    mocks.account.mockResolvedValue(connected);
    mocks.fetch.mockResolvedValue(Response.json({ outcome: "disconnected" }));
    await render();
    // The dialog is the page's to open and close.
    const [dialog] = mocks.dialog.mock.lastCall ?? [];
    expect(dialog?.open).toBe(false);
    expect(dialog?.onOpenChange).toBeTypeOf("function");
    press("Disconnect");

    await vi.waitFor(() => {
      expect(mocks.refresh).toHaveBeenCalledOnce();
    });
    expect(mocks.replace).toHaveBeenCalledWith(
      "/?google=disconnected#connectors",
      { scroll: false }
    );
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/connectors/google/disconnect",
      { method: "POST", redirect: "manual" }
    );
  });

  it("sends a member whose session ended to sign in", async () => {
    mocks.account.mockResolvedValue(connected);
    mocks.fetch.mockResolvedValue(
      Response.json({ error: "unauthenticated" }, { status: 401 })
    );
    await render();
    press("Disconnect");

    await vi.waitFor(() => {
      expect(mocks.reload).toHaveBeenCalledOnce();
    });
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
