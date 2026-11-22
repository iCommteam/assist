import { NotFoundError } from "@onkernel/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEveState } from "@tests/helpers/eve-state";
import {
  assertWorkerNotBlocked,
  checkBrowserPages,
  type BrowserPageState,
} from "../policy/page-check";

const mocks = vi.hoisted(() => ({
  execute:
    vi.fn<
      (
        sessionId: string,
        body: { readonly code: string; readonly timeout_sec: number },
        options: { readonly signal?: AbortSignal }
      ) => Promise<{ readonly result?: unknown; readonly success: boolean }>
    >(),
}));

vi.mock("eve/context", () => import("@tests/helpers/eve-state"));
vi.mock("@agent/subagents/browser-agent/lib/kernel", () => ({
  kernel: { browsers: { playwright: { execute: mocks.execute } } },
}));

function page(overrides: Partial<BrowserPageState> = {}): BrowserPageState {
  return {
    frames: [],
    status: 200,
    text: "Welcome to the shop.",
    timeOrigin: 1_000,
    title: "Shop",
    url: "https://shop.example.com/",
    ...overrides,
  };
}

function browserShows(...pages: BrowserPageState[]) {
  mocks.execute.mockResolvedValueOnce({ result: pages, success: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEveState();
  mocks.execute.mockResolvedValue({ result: true, success: true });
});

describe("browser page check", () => {
  it("passes ordinary pages, including an invisible reCAPTCHA badge", async () => {
    browserShows(
      page(),
      page({
        frames: [
          "https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=invisible",
          "https://www.google.com/recaptcha/api2/bframe?k=key",
        ],
        text: "Sign in. This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.",
        title: "Sign in",
        url: "https://login.example.com/",
      }),
      page({ status: 404, title: "Not found" }),
      page({ status: null, text: "", title: "", url: "about:blank" })
    );

    const check = await checkBrowserPages("browser-1");

    expect(check.status).toBe("clear");
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(() => {
      assertWorkerNotBlocked();
    }).not.toThrow();
  });

  it.each([
    ["a 403 main document", page({ status: 403 }), "HTTP 403"],
    ["a 429 main document", page({ status: 429 }), "HTTP 429"],
    ["a 503 main document", page({ status: 503 }), "HTTP 503"],
    ["a robot check title", page({ title: "Robot Check" }), '("robot check")'],
    [
      "Amazon-style CAPTCHA text",
      page({
        text: "Enter the characters you see below. Sorry, we just need to make sure you’re not a robot.",
      }),
      '("enter the characters you see below")',
    ],
    [
      "an automated access notice",
      page({
        text: "To discuss automated access to our data please contact us.",
      }),
      '("automated access")',
    ],
    [
      "a Cloudflare interstitial",
      page({ text: "Verifying you are human. This may take a few seconds." }),
      '("verifying you are human")',
    ],
    [
      "a Google unusual-traffic page",
      page({ url: "https://www.google.com/sorry/index?continue=x" }),
      '("google.com/sorry/")',
    ],
    [
      "a visible reCAPTCHA checkbox",
      page({
        frames: [
          "https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=normal&cb=x",
        ],
      }),
      '("reCAPTCHA checkbox")',
    ],
    [
      "an hCaptcha checkbox",
      page({
        frames: [
          "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=1",
        ],
      }),
      '("hCaptcha checkbox")',
    ],
  ])("stops for good at %s", async (_label, blocked, reason) => {
    browserShows(page(), blocked);

    const check = await checkBrowserPages("browser-1");

    expect(check.status).toBe("blocked");
    const message = check.status === "blocked" ? check.message : "";
    expect(message).toContain(`BLOCKED: ${new URL(blocked.url).hostname}`);
    expect(message).toContain(reason);
    expect(message).toContain("Do not retry");
    expect(message).not.toContain("Welcome to the shop");
    expect(() => {
      assertWorkerNotBlocked();
    }).toThrow(/already stopped at a block/u);
  });

  it("does not count an invisible hCaptcha as a block", async () => {
    browserShows(
      page({
        frames: [
          "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox-invisible",
        ],
      })
    );
    expect((await checkBrowserPages("browser-1")).status).toBe("clear");
  });

  it("resets an Amazon tab and refuses it without blocking the worker", async () => {
    browserShows(
      page(),
      page({ title: "Amazon.com", url: "https://www.amazon.com/dp/B000" })
    );

    const check = await checkBrowserPages("browser-1");

    expect(check.status).toBe("refused");
    expect(check.status === "refused" ? check.message : "").toContain(
      "www.amazon.com is an Amazon site"
    );
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[1]?.[1].code).toContain(
      '["https://www.amazon.com/dp/B000"]'
    );
    expect(mocks.execute.mock.calls[1]?.[1].code).toContain("about:blank");
    expect(() => {
      assertWorkerNotBlocked();
    }).not.toThrow();
  });

  it("recognizes Chrome's URLBlocklist page for an Amazon host", async () => {
    browserShows(
      page({
        status: 0,
        text: "This page is blocked\n\nYour organization doesn’t allow you to view this site",
        title: "sellercentral.amazon.com",
        url: "chrome-error://chromewebdata/",
      })
    );

    const check = await checkBrowserPages("browser-1");

    expect(check.status).toBe("refused");
    expect(check.status === "refused" ? check.message : "").toContain(
      "sellercentral.amazon.com is an Amazon site"
    );
  });

  it("withholds the result when the page check cannot run, without blocking", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValueOnce({ success: false });

    await expect(checkBrowserPages("browser-1")).rejects.toThrow(
      /page check after this browser action could not run/u
    );
    mocks.execute.mockRejectedValueOnce(new Error("network"));
    await expect(checkBrowserPages("browser-1")).rejects.toThrow(
      /could not run/u
    );
    // A browser deleted by a parallel call is reported as gone.
    mocks.execute.mockRejectedValueOnce(
      new NotFoundError(404, undefined, "not found", new Headers())
    );
    await expect(checkBrowserPages("browser-1")).rejects.toThrow(
      /This browser no longer exists/u
    );
    expect(() => {
      assertWorkerNotBlocked();
    }).not.toThrow();
    for (const [index, reason] of [
      "inspection failed",
      "request failed",
      "browser gone",
    ].entries()) {
      expect(warn).toHaveBeenNthCalledWith(
        index + 1,
        "[browser-policy] page check failed",
        { reason }
      );
    }
    warn.mockRestore();
  });

  it("reads every tab of every context from the browser", async () => {
    browserShows(page());
    await checkBrowserPages("browser-1", new AbortController().signal);

    const [sessionId, body] = mocks.execute.mock.calls[0] ?? [];
    expect(sessionId).toBe("browser-1");
    expect(body?.code).toContain("browser.contexts()");
    expect(body?.code).toContain("responseStatus");
    expect(body?.code).toContain("performance.timeOrigin");
  });
});
