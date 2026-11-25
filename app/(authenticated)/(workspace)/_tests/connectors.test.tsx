import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  client: vi.fn<typeof googleOAuthClient>(),
  search: { value: "" },
  session: vi.fn<typeof getAuthSession>(),
}));

vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/navigation", () => ({
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

const { ConnectorsSection } = await import("../_components/connectors");

const connected: GoogleAccountSummary = {
  connectedAt: "2026-11-25T08:00:00.000Z",
  email: "member@icommteam.com",
  needsReconnect: false,
  scopes: [...googleRequestedScopes],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search.value = "";
  mocks.session.mockResolvedValue(authSessionFor({ id: "user-1" }));
  mocks.client.mockReturnValue({
    clientId: "client.apps.googleusercontent.com",
    clientSecret: "client-secret",
  });
  mocks.account.mockResolvedValue(undefined);
});

async function render() {
  return renderToStaticMarkup(await ConnectorsSection());
}

describe("the Workspace page's Connectors", () => {
  it("says an administrator has not set Google up, and offers nothing to press", async () => {
    mocks.client.mockReturnValue(undefined);
    const html = await render();

    expect(html).toContain("Connectors");
    expect(html).toContain(
      "An administrator has not set up Google for assist yet."
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

    expect(html).toContain("member@icommteam.com");
    expect(html).toContain("Connected");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("Connect Google");
    expect(html.match(/Allowed: /gu)).toHaveLength(5);
    expect(html).toContain("Gmail · Write drafts, and send mail you approve");
    expect(html).not.toContain("To allow what is missing");
  });

  it("marks what the member unticked on Google's screen, and says how to allow it", async () => {
    mocks.account.mockResolvedValue({
      ...connected,
      scopes: connected.scopes.filter(
        (scope) => !scope.endsWith("drive.readonly")
      ),
    });
    const html = await render();

    expect(html).toContain(
      "Not allowed: </span>Drive · Search and read files, Docs and Sheets"
    );
    expect(html).toContain("To allow what is missing");
  });

  it("asks a member whose grant Google refused to reconnect", async () => {
    mocks.account.mockResolvedValue({ ...connected, needsReconnect: true });
    const html = await render();

    expect(html).toContain("Reconnect needed");
    expect(html).toContain("Reconnect");
    expect(html).toContain("Disconnect");
  });

  it("says how the last connect went, from the page's address", async () => {
    mocks.search.value = "google=denied";
    expect(await render()).toContain("Google access was not granted");
    mocks.search.value = "google=unknown";
    expect(await render()).not.toContain('role="alert"');
  });
});
