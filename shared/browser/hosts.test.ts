import { describe, expect, it } from "vitest";
import { isIdentityProviderHost } from "@shared/browser/hosts";

describe("identity provider hosts", () => {
  it.each([
    "google.com",
    "accounts.google.com",
    "Accounts.Google.COM.",
    "oauth2.googleapis.com",
    "googleapis.com",
    "login.microsoftonline.com",
    "login.live.com",
    "acme.okta.com",
    "acme.us.auth0.com",
    "acme.onelogin.com",
    "login.microsoft.com",
    "appleid.apple.com",
    "idmsa.apple.com",
    "account.apple.com",
  ])("refuses %s", (host) => {
    expect(isIdentityProviderHost(host)).toBe(true);
  });

  it.each([
    "auth.openai.com",
    "chatgpt.com",
    "notgoogle.com",
    "google.com.evil.example",
    "microsoft.com",
    "billing.microsoft.com",
    "apple.com",
    "www.apple.com",
    "okta-example.com",
    "",
  ])("allows %s", (host) => {
    expect(isIdentityProviderHost(host)).toBe(false);
  });
});
