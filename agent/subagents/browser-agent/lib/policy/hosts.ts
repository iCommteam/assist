import type { SessionContext } from "eve/context";
import { parse } from "tldts";
import { siteLoginOfSession } from "@agent/lib/site-principal";

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

// Many suppliers bill through Stripe, whose hosted invoice page and its PDF
// live on these hosts. A pinned site task may also open each of them, that
// exact host alone.
export const stripeInvoiceHosts: readonly string[] = [
  "billing.stripe.com",
  "files.stripe.com",
  "invoice.stripe.com",
  "pay.stripe.com",
];

// A site task pinned to one saved login may open only that login's site: the
// login's host and every host under its registrable domain, plus Stripe's
// invoice hosts. Private suffixes count as public ones, so a portal on
// shop.myshopify.com does not open every other shop there. An IP address, or a
// host with no registrable domain such as localhost or a bare public suffix,
// allows only itself. A login on Amazon opens nothing at all.
export function siteNavigationFence(loginOrigin: string) {
  const host = normalizedHost(new URL(loginOrigin).hostname);
  const { domain, isIp } = parse(host, { allowPrivateDomains: true });
  const site = isIp
    ? { domain: host, subdomains: false, urlFilter: host }
    : domain
      ? { domain, subdomains: true, urlFilter: domain }
      : { domain: host, subdomains: false, urlFilter: `.${host}` };
  return {
    ...site,
    hosts: isAmazonHost(site.domain) ? [] : stripeInvoiceHosts,
  };
}

type SiteNavigationFence = ReturnType<typeof siteNavigationFence>;

// The fence of a worker's site task, or undefined when only the Amazon block
// applies: an interactive or scheduled session, or a site task with no pin.
export function workerNavigationFence(
  session: Pick<SessionContext["session"], "auth">
) {
  const login = siteLoginOfSession(session.auth.initiator);
  return login ? siteNavigationFence(login.origin) : undefined;
}

// Chrome's policy for a new browser. A fenced browser blocks every URL but its
// site's (a more specific filter wins, and a tie goes to the allowlist), so it
// never allowlists an Amazon domain. A leading dot matches that host alone.
export function browserChromePolicy(fence: SiteNavigationFence | undefined) {
  if (!fence) return { URLBlocklist: amazonUrlBlocklist };
  const blocklist = ["*", ...amazonUrlBlocklist];
  return isAmazonHost(fence.domain)
    ? { URLBlocklist: blocklist }
    : {
        URLAllowlist: [
          fence.urlFilter,
          ...fence.hosts.map((host) => `.${host}`),
        ],
        URLBlocklist: blocklist,
      };
}

// Throws the policy refusal for a URL a tool is about to open. Only web pages
// may be opened at all, and a fenced task only its site's.
export function assertNavigableUrl(url: string, fence?: SiteNavigationFence) {
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
  if (fence && !isInsideFence(parsed.hostname, fence)) {
    const besides =
      fence.hosts.length > 0 ? " besides Stripe's invoice pages" : "";
    throw new Error(
      `${parsed.hostname} is outside ${fence.domain}, the only site this task may open${besides}. Do not try another route to it. Finish the parts of the assignment that stay on ${fence.domain}, or return status "failure" with this blocker.`
    );
  }
}

// Whether a fenced task may open a host; Amazon is refused before this.
export function isInsideFence(hostname: string, fence: SiteNavigationFence) {
  const host = normalizedHost(hostname);
  return (
    host === fence.domain ||
    (fence.subdomains && host.endsWith(`.${fence.domain}`)) ||
    fence.hosts.includes(host)
  );
}

function normalizedHost(hostname: string) {
  return hostname.trim().toLowerCase().replace(/\.+$/u, "");
}
