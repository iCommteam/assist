// Amazon sites stay closed to the browser worker until a live-proven
// "Agent/iCommAssist" user agent exists. Two layers enforce it: every tool
// that names a URL refuses an Amazon host before navigating, and every browser
// is created with a Chrome URLBlocklist (Kernel accepts it; a blocked load
// fails with ERR_BLOCKED_BY_ADMINISTRATOR), which also covers link clicks and
// redirects. The page check in ./page-check.ts reports what slips past both.

// Chrome's URLBlocklist has no TLD wildcard, so each marketplace is listed. An
// entry also blocks every subdomain, such as sellercentral, advertising and
// vendorcentral.
const amazonMarketplaceDomains = [
  "amazon.ae",
  "amazon.at",
  "amazon.ca",
  "amazon.cn",
  "amazon.co.jp",
  "amazon.co.uk",
  "amazon.co.za",
  "amazon.com",
  "amazon.com.au",
  "amazon.com.be",
  "amazon.com.br",
  "amazon.com.mx",
  "amazon.com.tr",
  "amazon.de",
  "amazon.eg",
  "amazon.es",
  "amazon.fr",
  "amazon.ie",
  "amazon.in",
  "amazon.it",
  "amazon.nl",
  "amazon.pl",
  "amazon.sa",
  "amazon.se",
  "amazon.sg",
] as const;

// Amazon's link shorteners redirect into the marketplaces.
const amazonShortLinkDomains = [
  "a.co",
  "amzn.asia",
  "amzn.com",
  "amzn.eu",
  "amzn.to",
] as const;

export const amazonUrlBlocklist: readonly string[] = [
  ...amazonMarketplaceDomains,
  ...amazonShortLinkDomains,
];

export function isAmazonHost(hostname: string) {
  const host = hostname.trim().toLowerCase().replace(/\.+$/u, "");
  if (host.length === 0) return false;
  if (
    amazonShortLinkDomains.some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    )
  ) {
    return true;
  }
  // amazon.<tld>, amazon.co.<cc> or amazon.com.<cc>, with any subdomain.
  const labels = host.split(".");
  return labels.some((label, index) => {
    if (label !== "amazon") return false;
    const suffix = labels.slice(index + 1);
    if (suffix.length === 1) return /^[a-z]{2,}$/u.test(suffix[0] ?? "");
    return (
      suffix.length === 2 &&
      (suffix[0] === "co" || suffix[0] === "com") &&
      /^[a-z]{2}$/u.test(suffix[1] ?? "")
    );
  });
}

export function amazonPolicyRefusal(host: string) {
  return `${host} is an Amazon site. Amazon sites, including Seller Central, Amazon Ads and Vendor Central, are blocked by policy for now, so iCommAssist cannot open them. Do not try another route to the site. Finish the parts of the assignment that do not need it, or return status "failure" with this blocker.`;
}

// Throws the policy refusal for a URL a tool is about to open. Only web pages
// may be opened at all.
export function assertNavigableUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The browser can open only absolute http or https URLs.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The browser can open only absolute http or https URLs.");
  }
  if (isAmazonHost(parsed.hostname)) {
    throw new Error(amazonPolicyRefusal(parsed.hostname));
  }
}
