import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  getAuthSession,
  getTwoFactorSetupSession,
} from "@db/services/auth/session";
import { authSessionFor } from "@tests/helpers/auth-session";
import SignInPage from "../page";

const sessions = vi.hoisted(() => ({
  complete: vi.fn<typeof getAuthSession>(),
  setup: vi.fn<typeof getTwoFactorSetupSession>(),
}));

vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`Redirect: ${url}`);
  },
}));
vi.mock("@db/services/auth/session", () => ({
  getAuthSession: sessions.complete,
  getTwoFactorSetupSession: sessions.setup,
}));
vi.mock("@app/(auth)/sign-in/_components/sign-in-form", () => ({
  SignInForm: ({ callbackUrl }: { readonly callbackUrl: string }) =>
    createElement("form", { action: callbackUrl }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  sessions.complete.mockResolvedValue(null);
  sessions.setup.mockResolvedValue(null);
});

function render(searchParams: Record<string, string>) {
  return SignInPage({
    params: Promise.resolve({}),
    searchParams: Promise.resolve(searchParams),
  });
}

describe("sign-in page", () => {
  it("shows the email and password form to a visitor", async () => {
    const html = renderToStaticMarkup(await render({ callbackUrl: "/vault" }));

    expect(html).toContain("Sign In");
    expect(html).toContain('action="/vault"');
  });

  it("sends a completed sign-in on to its callback", async () => {
    sessions.complete.mockResolvedValue(authSessionFor({ id: "user-1" }));

    await expect(render({ callbackUrl: "/vault" })).rejects.toThrow(
      "Redirect: /vault"
    );
  });

  it("lets a completed sign-in authenticate again", async () => {
    sessions.complete.mockResolvedValue(authSessionFor({ id: "user-1" }));

    const html = renderToStaticMarkup(
      await render({ callbackUrl: "/vault", reauthenticate: "true" })
    );

    expect(html).toContain("Sign in again");
  });

  it("continues a password-only session to authenticator setup", async () => {
    sessions.setup.mockResolvedValue({
      email: "member@example.test",
      enrolled: false,
    });

    await expect(render({ callbackUrl: "/vault" })).rejects.toThrow(
      "Redirect: /two-factor?callbackUrl=%2Fvault"
    );
  });

  it.each(["//evil.example/path", "https://evil.example", "/\\evil.example"])(
    "drops the off-site callback %s",
    async (callbackUrl) => {
      sessions.complete.mockResolvedValue(authSessionFor({ id: "user-1" }));

      await expect(render({ callbackUrl })).rejects.toThrow(/^Redirect: \/$/u);
    }
  );
});
