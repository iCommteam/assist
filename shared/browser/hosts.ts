// Hosts whose policy both the site API and the browser worker apply: Amazon,
// which no browser opens, Stripe's invoice hosts, which a pinned site task
// may open, and identity providers, which no site may save a login on.

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
  const host = normalizedHost(hostname);
  if (host.length === 0) return false;
  if (amazonShortLinkDomains.some((domain) => isUnder(host, domain))) {
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

// Many suppliers bill through Stripe, whose hosted invoice page and its PDF
// live on these hosts. A pinned site task may also open each of them, that
// exact host alone.
export const stripeInvoiceHosts: readonly string[] = [
  "billing.stripe.com",
  "files.stripe.com",
  "invoice.stripe.com",
  "pay.stripe.com",
];

// A login saved on an identity provider would hand the agent a company's
// whole identity, so a site saves none there, as its origin or as a host its
// task also opens. These match every host under them, not only by registrable
// domain: googleapis.com is a private suffix, so each of its hosts is a
// registrable domain of its own.
const identityProviderDomains = [
  "auth0.com",
  "google.com",
  "googleapis.com",
  "live.com",
  "microsoftonline.com",
  "okta.com",
  "onelogin.com",
] as const;

// Microsoft and Apple serve much else under their own domains, so only their
// sign-in hosts are listed.
const identityProviderHosts = [
  "account.apple.com",
  "appleid.apple.com",
  "idmsa.apple.com",
  "login.microsoft.com",
] as const;

export function isIdentityProviderHost(hostname: string) {
  const host = normalizedHost(hostname);
  return (
    identityProviderDomains.some((domain) => isUnder(host, domain)) ||
    identityProviderHosts.some((listed) => host === listed)
  );
}

function isUnder(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

function normalizedHost(hostname: string) {
  return hostname.trim().toLowerCase().replace(/\.+$/u, "");
}
