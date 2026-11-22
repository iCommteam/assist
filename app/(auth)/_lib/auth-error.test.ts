import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./auth-error";
import { callbackUrlFrom } from "./callback-url";

describe("sign-in error copy", () => {
  it("never tells a caller whether an email is on the team list", () => {
    const refusedSignIn = authErrorMessage(
      { code: "INVALID_EMAIL_OR_PASSWORD", status: 401 },
      "fallback"
    );
    const refusedSignUp = authErrorMessage(
      { code: "SIGN_UP_REJECTED", status: 400 },
      "fallback"
    );

    for (const message of [refusedSignIn, refusedSignUp]) {
      expect(message).not.toMatch(/list|allow|team|registered|exist/iu);
    }
    expect(refusedSignUp).toBe(
      "This email and signup code cannot create an account."
    );
  });

  it("explains rate limits and falls back for unknown codes", () => {
    expect(authErrorMessage({ code: "ANY", status: 429 }, "fallback")).toMatch(
      /Too many attempts/u
    );
    expect(authErrorMessage({ code: "UNKNOWN", status: 500 }, "fallback")).toBe(
      "fallback"
    );
  });
});

describe("sign-in callback", () => {
  it.each([
    ["/vault?tab=logins", "/vault?tab=logins"],
    [["/chat", "/vault"], "/chat"],
    ["/a/../vault#logins", "/vault#logins"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example", "/"],
    // The browser drops tabs and newlines before it parses a link.
    ["/\t/evil.example", "/"],
    ["/\n/evil.example", "/"],
    ["/\r\n/evil.example", "/"],
    ["/\t\\evil.example", "/"],
    // Dot segments that leave a protocol-relative path behind.
    ["/.//evil.example", "/"],
    ["/..//evil.example", "/"],
    ["/%2e//evil.example", "/"],
    ["/./\\evil.example", "/"],
    [undefined, "/"],
  ])("keeps only same-site paths from %j", (value, expected) => {
    expect(callbackUrlFrom(value)).toBe(expected);
  });
});
