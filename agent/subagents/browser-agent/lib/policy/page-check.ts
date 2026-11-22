import { NotFoundError } from "@onkernel/sdk";
import { defineState } from "eve/context";
import { z } from "zod";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import {
  amazonPolicyRefusal,
  isAmazonHost,
} from "@agent/subagents/browser-agent/lib/policy/hosts";

// The deterministic stop. After every page-reading or page-changing worker
// tool, this reads each open tab (URL, title, visible text, main-document
// status, child frames) from the browser itself. A CAPTCHA, robot check or
// access block ends the worker's browser use for the rest of its session; an
// Amazon page is reset and refused. The model never sees either page.

const pageStateSchema = z.object({
  frames: z.array(z.string()),
  status: z.number().nullable(),
  text: z.string(),
  timeOrigin: z.number().nullable(),
  title: z.string(),
  url: z.string(),
});

export type BrowserPageState = z.infer<typeof pageStateSchema>;

const pageStatesSchema = z.array(pageStateSchema);

// Runs in Kernel's Playwright context, where `page` and `context` are already
// declared. The per-tab timeout keeps one hung tab from hiding the others.
const inspectionCode = `
const settle = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), 3000))]);
const states = [];
for (const browserContext of browser.contexts()) {
  for (const tab of browserContext.pages()) {
    const frames = tab.frames().slice(1, 41).map((frame) => frame.url());
    const state = await settle(tab.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      return {
        status: navigation && typeof navigation.responseStatus === "number" ? navigation.responseStatus : null,
        text: document.body ? document.body.innerText.slice(0, 4000) : "",
        timeOrigin: performance.timeOrigin,
        title: document.title.slice(0, 300),
      };
    }).catch(() => null));
    states.push({ ...(state ?? { status: null, text: "", timeOrigin: null, title: "" }), frames, url: tab.url() });
  }
}
return states;`;

const resetCode = (urls: readonly string[]) => `
const urls = new Set(${JSON.stringify(urls)});
for (const browserContext of browser.contexts()) {
  for (const tab of browserContext.pages()) {
    if (urls.has(tab.url())) await tab.goto("about:blank").catch(() => undefined);
  }
}
return true;`;

// Main-document statuses that mean the site refused the visit.
const blockedStatuses = new Set([403, 429, 503]);

const blockUrlMarkers = [
  "/errors/validatecaptcha",
  "captcha-delivery.com",
  "/cdn-cgi/challenge-platform/",
  "__cf_chl_",
  "google.com/sorry/",
  "/_incapsula_resource",
  "/distil_r_captcha",
];

const blockTitleMarkers = [
  "robot check",
  "attention required! | cloudflare",
  "are you a robot",
  "are you a human",
  "pardon our interruption",
  "human verification",
  "verify you are human",
  "captcha",
];

// Phrases from challenge and block pages. Kept specific: a page that only
// carries an invisible reCAPTCHA badge ("protected by reCAPTCHA") is normal.
const blockTextMarkers = [
  "enter the characters you see below",
  "type the characters you see",
  "not a robot",
  "automated access",
  "unusual traffic from your computer network",
  "verify you are human",
  "verify that you are human",
  "verifying you are human",
  "confirm you are a human",
  "prove you are human",
  "prove you're human",
  "are you a robot",
  "are you a human",
  "checking your browser before accessing",
  "checking if the site connection is secure",
  "access to this page has been denied",
  "you have been blocked",
  "request unsuccessful. incapsula",
  "complete the security check",
  "solve the captcha",
  "complete the captcha",
];

const workerBlock = defineState<{ readonly reason: string | null }>(
  "worker.browser-policy.block",
  () => ({ reason: null })
);

export function assertWorkerNotBlocked() {
  const { reason } = workerBlock.get();
  if (reason !== null) throw new Error(stoppedMessage(reason));
}

export async function inspectBrowserPages(
  sessionId: string,
  signal?: AbortSignal
) {
  const outcome = await kernel.browsers.playwright
    .execute(sessionId, { code: inspectionCode, timeout_sec: 10 }, { signal })
    .then((result) => ({ gone: false, result }))
    .catch((cause: unknown) => ({
      gone: cause instanceof NotFoundError,
      result: undefined,
    }));
  const { gone, result } = outcome;
  const pages = pageStatesSchema.safeParse(result?.result);
  if (result?.success && pages.success) return pages.data;
  // Only the failure kind: Kernel's error text can quote the page.
  console.warn("[browser-policy] page check failed", {
    reason: gone
      ? "browser gone"
      : result
        ? "inspection failed"
        : "request failed",
  });
  throw new Error(
    gone
      ? "This browser no longer exists, so the result of this action was withheld. Do not retry it; create a new browser only if the assignment still needs one."
      : "The page check after this browser action could not run, so its result was withheld. Take a fresh browser_snapshot to continue."
  );
}

export type BrowserPageCheck =
  | { readonly status: "clear"; readonly pages: readonly BrowserPageState[] }
  | { readonly status: "blocked" | "refused"; readonly message: string };

export async function checkBrowserPages(
  sessionId: string,
  signal?: AbortSignal
): Promise<BrowserPageCheck> {
  const pages = await inspectBrowserPages(sessionId, signal);
  const amazonPages = pages.filter((page) => amazonHostOf(page) !== undefined);
  if (amazonPages.length > 0) {
    await kernel.browsers.playwright
      .execute(
        sessionId,
        {
          code: resetCode(amazonPages.map((page) => page.url)),
          timeout_sec: 10,
        },
        { signal }
      )
      .catch(() => undefined);
  }

  const reason = pages
    .filter((page) => amazonHostOf(page) === undefined)
    .map(blockReason)
    .find((value) => value !== undefined);
  if (reason !== undefined) {
    workerBlock.update(() => ({ reason }));
    return { message: blockedMessage(reason), status: "blocked" };
  }

  const amazonHost = amazonPages.map(amazonHostOf).find(Boolean);
  if (amazonHost) {
    return {
      message: `REFUSED BY POLICY: the tab was reset and its content withheld. ${amazonPolicyRefusal(amazonHost)}`,
      status: "refused",
    };
  }
  return { pages, status: "clear" };
}

// Chrome shows a URLBlocklist refusal as chrome-error://chromewebdata/ titled
// with the refused host.
function amazonHostOf(page: BrowserPageState) {
  const host = hostOf(page.url);
  if (host && isAmazonHost(host)) return host;
  if (page.url.startsWith("chrome-error://") && isAmazonHost(page.title)) {
    return page.title.trim().toLowerCase();
  }
  return undefined;
}

export function blockReason(page: BrowserPageState) {
  if (!/^https?:/u.test(page.url)) return undefined;
  const host = hostOf(page.url) ?? "the page";
  if (page.status !== null && blockedStatuses.has(page.status)) {
    return `${host} answered HTTP ${String(page.status)}`;
  }
  const url = page.url.toLowerCase();
  const title = normalized(page.title);
  const text = normalized(page.text);
  const marker =
    blockUrlMarkers.find((value) => url.includes(value)) ??
    blockTitleMarkers.find((value) => title.includes(value)) ??
    blockTextMarkers.find((value) => text.includes(value)) ??
    page.frames.map(challengeFrame).find((value) => value !== undefined);
  return marker === undefined
    ? undefined
    : `${host} shows a CAPTCHA, robot check or access block ("${marker}")`;
}

function challengeFrame(frameUrl: string) {
  const url = frameUrl.toLowerCase();
  if (
    url.includes("/recaptcha/") &&
    url.includes("/anchor") &&
    /[?&]size=(?:normal|compact)(?:&|$)/u.test(url)
  ) {
    return "reCAPTCHA checkbox";
  }
  if (
    hostOf(url)?.endsWith("hcaptcha.com") &&
    url.includes("frame=checkbox") &&
    !url.includes("frame=checkbox-invisible")
  ) {
    return "hCaptcha checkbox";
  }
  if (url.includes("captcha-delivery.com")) return "DataDome challenge";
  return undefined;
}

function blockedMessage(reason: string) {
  return `BLOCKED: ${reason}. The page content was withheld. ${stopInstruction}`;
}

function stoppedMessage(reason: string) {
  return `This browser task already stopped at a block: ${reason}. No further browser actions are allowed in this task. ${stopInstruction}`;
}

const stopInstruction =
  'Stop now. Do not retry, wait for it to clear, solve it, click any "I am not a robot" control, create another browser, or try another route. Delete the browser with manage_browsers, then return status "failure" reporting this blocker.';

function normalized(value: string) {
  return value.toLowerCase().replaceAll("’", "'").replace(/\s+/gu, " ");
}

function hostOf(url: string) {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? hostname : undefined;
  } catch {
    return undefined;
  }
}
