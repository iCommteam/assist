import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  getAuthSession,
  getTwoFactorSetupSession,
} from "@db/services/auth/session";
import { authSessionFor } from "@tests/helpers/auth-session";
import TwoFactorPage from "../page";

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
vi.mock("@app/(auth)/two-factor/_components/two-factor-setup", () => ({
  TwoFactorSetup: ({ callbackUrl }: { readonly callbackUrl: string }) =>
    createElement("form", { action: callbackUrl }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  sessions.complete.mockResolvedValue(null);
  sessions.setup.mockResolvedValue(null);
});

function render() {
  return TwoFactorPage({
    params: Promise.resolve({}),
    searchParams: Promise.resolve({ callbackUrl: "/vault" }),
  });
}

describe("authenticator setup page", () => {
  it("sends a visitor without a password session to sign-in", async () => {
    await expect(render()).rejects.toThrow("Redirect: /sign-in");
  });

  it("sends a completed sign-in on to its callback", async () => {
    sessions.complete.mockResolvedValue(authSessionFor({ id: "user-1" }));

    await expect(render()).rejects.toThrow("Redirect: /vault");
  });

  it("offers setup to a password-only session without an authenticator", async () => {
    sessions.setup.mockResolvedValue({
      email: "member@example.test",
      enrolled: false,
    });

    const html = renderToStaticMarkup(await render());

    expect(html).toContain("Set Up Authenticator");
    expect(html).toContain("member@example.test");
    expect(html).toContain('action="/vault"');
  });

  it("asks an enrolled member's stale password session to sign in again", async () => {
    sessions.setup.mockResolvedValue({
      email: "member@example.test",
      enrolled: true,
    });

    const html = renderToStaticMarkup(await render());

    expect(html).toContain("Sign In Again");
    expect(html).not.toContain('action="/vault"');
  });
});
