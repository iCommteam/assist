import type { SessionContext } from "eve/context";
import { siteLoginOfSession } from "@agent/lib/site-principal";
import {
  amazonUrlBlocklist,
  isAmazonHost,
  isInsideFence,
  siteNavigationFence,
} from "@shared/browser/hosts";

// Amazon sites stay closed to the browser worker until a live-proven
// "Agent/iCommAssist" user agent exists. Two layers enforce it: every tool
// that names a URL refuses an Amazon host before navigating, and every browser
// is created with a Chrome URLBlocklist (Kernel accepts it; a blocked load
// fails with ERR_BLOCKED_BY_ADMINISTRATOR), which also covers link clicks and
// redirects. The page check in ./page-check.ts reports what slips past both.

export function amazonPolicyRefusal(host: string) {
  return `${host} is an Amazon site. Amazon sites, including Seller Central, Amazon Ads and Vendor Central, are blocked by policy for now, so iCommAssist cannot open them. Do not try another route to the site. Finish the parts of the assignment that do not need it, or return status "failure" with this blocker.`;
}

type SiteNavigationFence = ReturnType<typeof siteNavigationFence>;

// The fence of a worker's site task, or undefined when only the Amazon block
// applies: an interactive or scheduled session, or a site task with no pin.
export function workerNavigationFence(
  session: Pick<SessionContext["session"], "auth">
) {
  const login = siteLoginOfSession(session.auth.initiator);
  return login ? siteNavigationFence(login.origin, login.alsoHosts) : undefined;
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
      fence.hosts.length > 0
        ? ` besides ${new Intl.ListFormat("en").format([
            ...fence.alsoHosts,
            "Stripe's invoice pages",
          ])}`
        : "";
    throw new Error(
      `${parsed.hostname} is outside ${fence.domain}, the only site this task may open${besides}. Do not try another route to it. Finish the parts of the assignment that stay on ${fence.domain}, or return status "failure" with this blocker.`
    );
  }
}
