import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn<() => void>(),
    replace: vi.fn<() => void>(),
  }),
}));
vi.mock("@web/auth/client", () => ({ authClient: {} }));

import { SignUpForm } from "../_components/sign-up-form";

describe("the sign-up form", () => {
  it("disables its submit button in the server's markup, so a tap before the page runs cannot send the password in the address", () => {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(SignUpForm)
      )
    );

    expect(html).toContain('type="password"');
    expect(/<button[^>]*type="submit"[^>]*>/u.exec(html)?.[0]).toContain(
      'disabled=""'
    );
  });
});
