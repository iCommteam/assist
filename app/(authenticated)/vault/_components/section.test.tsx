import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { VaultItem } from "@shared/vault/schema";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn<() => void>() }),
}));
vi.mock("@web/trpc/client", () => ({
  api: {
    vault: {
      remove: {
        useMutation: () => ({
          isPending: false,
          mutate: vi.fn<() => void>(),
        }),
      },
    },
  },
}));

import { VaultItemList } from "./section";

function item(
  overrides: Pick<VaultItem, "id" | "kind" | "label"> &
    Partial<Pick<VaultItem, "site">>
): VaultItem {
  return {
    account: "",
    createdAt: "2026-11-23T00:00:00.000Z",
    hasSecret: true,
    site: null,
    updatedAt: "2026-11-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("vault item list", () => {
  it("lets the owner copy a login's ID for site tasks, and only a login's", () => {
    const html = renderToStaticMarkup(
      createElement(VaultItemList, {
        items: [
          item({
            id: "7f0c2a4e-1d3b-4c5a-9e8f-0a1b2c3d4e5f",
            kind: "login",
            label: "Vendor",
          }),
          item({ id: "address-1", kind: "address", label: "Home" }),
        ],
      })
    );

    expect(html).toContain('aria-label="Copy the login ID of Vendor"');
    expect(html).toContain(
      'title="Login ID for site tasks: 7f0c2a4e-1d3b-4c5a-9e8f-0a1b2c3d4e5f"'
    );
    expect(html).not.toContain("Copy the login ID of Home");
    expect(html).not.toContain("address-1");
  });

  it("shows which site saved a login, and nothing for the owner's own", () => {
    const html = renderToStaticMarkup(
      createElement(VaultItemList, {
        items: [
          item({
            id: "login-site",
            kind: "login",
            label: "Vendor (Vadim)",
            site: "teemiq",
          }),
          item({ id: "login-own", kind: "login", label: "GitHub" }),
        ],
      })
    );

    expect(html.match(/Saved by /gu)).toHaveLength(1);
    expect(html).toContain("Saved by teemiq");
    expect(html.indexOf("Saved by")).toBeLessThan(html.indexOf("GitHub"));
    expect(html).toContain('aria-label="Remove Vendor (Vadim)"');
    expect(html).toContain('aria-label="Copy the login ID of Vendor (Vadim)"');
  });
});
