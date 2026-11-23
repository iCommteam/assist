import { describe, expect, it } from "vitest";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  amazonUrlBlocklist,
  assertNavigableUrl,
  browserChromePolicy,
  siteNavigationFence,
  workerNavigationFence,
} from "../policy/hosts";

const outside = /is outside .*, the only site this task may open/u;

describe("site navigation fence", () => {
  it.each([
    ["https://login.vendor.com", "vendor.com", "vendor.com"],
    ["https://vendor.com", "vendor.com", "vendor.com"],
    ["https://Login.Vendor.COM:8443", "vendor.com", "vendor.com"],
    ["https://billing.vendor.co.uk", "vendor.co.uk", "vendor.co.uk"],
    ["https://portal.vendor.com.au", "vendor.com.au", "vendor.com.au"],
    // A private suffix: one shop never opens the other shops on the platform.
    ["https://acme.myshopify.com", "acme.myshopify.com", "acme.myshopify.com"],
    ["https://co.uk", "co.uk", ".co.uk"],
    ["http://localhost:3000", "localhost", ".localhost"],
    ["https://10.0.0.7", "10.0.0.7", "10.0.0.7"],
  ])("fences %s to %s", (origin, domain, urlFilter) => {
    expect(siteNavigationFence(origin)).toMatchObject({ domain, urlFilter });
  });

  it("opens the login's registrable domain and its subdomains only", () => {
    const fence = siteNavigationFence("https://login.vendor.com");

    for (const url of [
      "https://vendor.com/",
      "https://login.vendor.com/sign-in",
      "https://billing.vendor.com/invoices?period=2026-10",
      "http://VENDOR.COM./",
      "https://a.b.vendor.com:8443/x",
    ]) {
      expect(() => {
        assertNavigableUrl(url, fence);
      }).not.toThrow();
    }
    for (const url of [
      "https://evilvendor.com/",
      "https://vendor.com.evil.com/",
      "https://vendor.com@evil.com/",
      "https://vendor.co/",
      "https://com/",
      "https://example.org/?next=https://vendor.com/",
    ]) {
      expect(() => {
        assertNavigableUrl(url, fence);
      }).toThrow(outside);
    }
  });

  it("keeps a multi-label public suffix and a private suffix closed", () => {
    const british = siteNavigationFence("https://billing.vendor.co.uk");
    const shop = siteNavigationFence("https://acme.myshopify.com");

    expect(() => {
      assertNavigableUrl("https://www.vendor.co.uk/", british);
    }).not.toThrow();
    expect(() => {
      assertNavigableUrl("https://other.co.uk/", british);
    }).toThrow(outside);
    expect(() => {
      assertNavigableUrl("https://co.uk/", british);
    }).toThrow(outside);
    expect(() => {
      assertNavigableUrl("https://checkout.acme.myshopify.com/", shop);
    }).not.toThrow();
    expect(() => {
      assertNavigableUrl("https://rival.myshopify.com/", shop);
    }).toThrow(outside);
  });

  it("opens only the exact host when the login has no registrable domain", () => {
    const suffix = siteNavigationFence("https://co.uk");
    const address = siteNavigationFence("https://10.0.0.7");

    expect(() => {
      assertNavigableUrl("https://co.uk/login", suffix);
    }).not.toThrow();
    expect(() => {
      assertNavigableUrl("https://vendor.co.uk/", suffix);
    }).toThrow(outside);
    expect(() => {
      assertNavigableUrl("http://10.0.0.7:8080/", address);
    }).not.toThrow();
    expect(() => {
      assertNavigableUrl("http://10.0.0.8/", address);
    }).toThrow(outside);
  });

  it("refuses Amazon before the fence, even inside it", () => {
    const fence = siteNavigationFence("https://sellercentral.amazon.com");

    expect(() => {
      assertNavigableUrl("https://sellercentral.amazon.com/", fence);
    }).toThrow(/blocked by policy for now/u);
    expect(() => {
      assertNavigableUrl("javascript:alert(1)", fence);
    }).toThrow("The browser can open only absolute http or https URLs.");
  });

  it("blocks every URL but the fenced site in Chrome, keeping the Amazon list", () => {
    expect(
      browserChromePolicy(siteNavigationFence("https://login.vendor.com"))
    ).toEqual({
      URLAllowlist: ["vendor.com"],
      URLBlocklist: ["*", ...amazonUrlBlocklist],
    });
    expect(browserChromePolicy(siteNavigationFence("https://co.uk"))).toEqual({
      URLAllowlist: [".co.uk"],
      URLBlocklist: ["*", ...amazonUrlBlocklist],
    });
    // An allowlisted Amazon domain would tie with its blocklist entry and win.
    expect(
      browserChromePolicy(
        siteNavigationFence("https://sellercentral.amazon.com")
      )
    ).toEqual({ URLBlocklist: ["*", ...amazonUrlBlocklist] });
    expect(browserChromePolicy(undefined)).toEqual({
      URLBlocklist: amazonUrlBlocklist,
    });
  });

  it("fences only a pinned site task, from its initiator", () => {
    const owner = accessScopeForUser("better-auth:owner-1");
    const pinned = sitePrincipal(
      {
        login: { id: "login-1", origin: "https://login.vendor.com" },
        op: "create",
        site: "teemiq",
      },
      "owner@example.test",
      owner
    );
    const unpinned = sitePrincipal(
      { op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );
    const member = {
      attributes: { workspaceId: owner.workspaceId },
      authenticator: "authjs",
      principalId: owner.userId,
      principalType: "user",
    };

    // A later turn, such as the owner writing into the task, keeps the pin.
    expect(
      workerNavigationFence({ auth: { current: member, initiator: pinned } })
    ).toMatchObject({ domain: "vendor.com" });
    expect(
      workerNavigationFence({ auth: { current: pinned, initiator: unpinned } })
    ).toBeUndefined();
    expect(
      workerNavigationFence({ auth: { current: pinned, initiator: member } })
    ).toBeUndefined();
    expect(
      workerNavigationFence({ auth: { current: member, initiator: null } })
    ).toBeUndefined();
  });
});
