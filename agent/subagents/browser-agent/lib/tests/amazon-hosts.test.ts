import { describe, expect, it } from "vitest";
import {
  amazonUrlBlocklist,
  assertNavigableUrl,
  isAmazonHost,
} from "../policy/hosts";

describe("Amazon host policy", () => {
  it.each([
    "amazon.com",
    "www.amazon.com",
    "WWW.AMAZON.COM",
    "www.amazon.com.",
    "smile.amazon.com",
    "sellercentral.amazon.com",
    "sellercentral-europe.amazon.com",
    "sellercentral.amazon.co.uk",
    "advertising.amazon.com",
    "vendorcentral.amazon.com",
    "amazon.co.uk",
    "www.amazon.co.jp",
    "amazon.com.au",
    "www.amazon.com.br",
    "amazon.de",
    "amazon.in",
    "amazon.sa",
    "a.co",
    "amzn.to",
    "www.amzn.com",
    "amzn.eu",
  ])("blocks %s", (host) => {
    expect(isAmazonHost(host)).toBe(true);
  });

  it.each([
    "example.com",
    "notamazon.com",
    "amazonaws.com",
    "s3.amazonaws.com",
    "amazon.com.evil.com",
    "amazon.example.com",
    "myamazon.co.uk",
    "amazon",
    "",
    "co",
    "aco",
    "evil-a.co.example",
  ])("allows %s", (host) => {
    expect(isAmazonHost(host)).toBe(false);
  });

  it("lists only hosts its own check blocks in the Chrome URLBlocklist", () => {
    expect(amazonUrlBlocklist.length).toBeGreaterThan(20);
    for (const domain of amazonUrlBlocklist) {
      expect(isAmazonHost(domain)).toBe(true);
    }
    expect(amazonUrlBlocklist).toContain("amazon.com");
    expect(amazonUrlBlocklist).toContain("amazon.co.uk");
  });

  it("refuses Amazon URLs and non-web schemes before navigation", () => {
    expect(() => {
      assertNavigableUrl("https://sellercentral.amazon.com/home");
    }).toThrow(/blocked by policy for now/u);
    expect(() => {
      assertNavigableUrl("https://AMZN.TO/abc");
    }).toThrow(/blocked by policy/u);
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "chrome://settings",
      "not a url",
    ]) {
      expect(() => {
        assertNavigableUrl(url);
      }).toThrow("The browser can open only absolute http or https URLs.");
    }
    expect(() => {
      assertNavigableUrl("https://example.com/checkout");
    }).not.toThrow();
  });
});
