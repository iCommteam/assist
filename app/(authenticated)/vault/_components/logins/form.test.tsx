import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn<() => void>() }),
}));
vi.mock("@web/trpc/client", () => ({
  api: {
    vault: {
      create: {
        useMutation: () => ({
          isPending: false,
          mutate: vi.fn<() => void>(),
        }),
      },
    },
  },
}));

import { LoginForm } from "./form";

describe("login form", () => {
  it("offers an optional, masked authenticator setup key field", () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, { onSaved: () => undefined })
    );

    expect(html).toContain("Authenticator setup key (optional)");
    expect(html).toContain("otpauth:// link");
    const field = /<input[^>]*id="vault-login-authenticator-key"[^>]*>/u.exec(
      html
    )?.[0];
    expect(field).toContain('type="password"');
    expect(field).toContain('autoComplete="off"');
    expect(field).toContain('spellCheck="false"');
  });
});
