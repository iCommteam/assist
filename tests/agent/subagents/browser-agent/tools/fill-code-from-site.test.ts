import { NotFoundError } from "@onkernel/sdk";
import type { SessionAuthContext } from "eve/context";
import type { ToolAnswer, WorkflowToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import type { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import type {
  assertKernelOneTimeCodeFocus,
  currentKernelPageOrigin,
  fillKernelOneTimeCode,
} from "@agent/subagents/browser-agent/lib/autofill/native";
import type * as PageCheckModule from "@agent/subagents/browser-agent/lib/policy/page-check";
import type {
  BrowserPageState,
  inspectBrowserPages,
} from "@agent/subagents/browser-agent/lib/policy/page-check";
import type { readVaultItem } from "@db/services/vault";
import { resetEveState } from "@tests/helpers/eve-state";
import { toolContextFor } from "@tests/helpers/tool-context";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { sealSiteCode } from "@shared/identity/site-code/seal";

const mocks = vi.hoisted(() => ({
  assertFocus: vi.fn<typeof assertKernelOneTimeCodeFocus>(),
  currentKernelPageOrigin: vi.fn<typeof currentKernelPageOrigin>(),
  fill: vi.fn<typeof fillKernelOneTimeCode>(),
  inspectBrowserPages: vi.fn<typeof inspectBrowserPages>(),
  readVaultItem: vi.fn<typeof readVaultItem>(),
  requireOwnedBrowserSession: vi.fn<typeof requireOwnedBrowserSession>(),
  requireWorkerScope: vi.fn<typeof requireWorkerScope>(),
  sleep: vi.fn<(durationMs: number) => Promise<void>>(),
}));

vi.mock("eve/context", () => import("@tests/helpers/eve-state"));
vi.mock("eve/workflow", () => ({ sleep: mocks.sleep }));
vi.mock("@agent/subagents/browser-agent/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));
vi.mock("@agent/subagents/browser-agent/lib/owned-browser", () => ({
  requireOwnedBrowserSession: mocks.requireOwnedBrowserSession,
}));
vi.mock("@db/services/vault", () => ({ readVaultItem: mocks.readVaultItem }));
vi.mock(
  "@agent/subagents/browser-agent/lib/policy/page-check",
  async (importOriginal) => ({
    ...(await importOriginal<typeof PageCheckModule>()),
    inspectBrowserPages: mocks.inspectBrowserPages,
  })
);
vi.mock("@agent/subagents/browser-agent/lib/autofill/native", () => ({
  assertKernelOneTimeCodeFocus: mocks.assertFocus,
  currentKernelPageOrigin: mocks.currentKernelPageOrigin,
  fillKernelOneTimeCode: mocks.fill,
}));

import fillCodeFromSite from "@agent/subagents/browser-agent/tools/fill_code_from_site";
import {
  forgetInjectedValues,
  redactBrowserOutput,
} from "@agent/subagents/browser-agent/lib/autofill/redaction";

const authSecret = "test-auth-secret-0123456789abcdefghijklmnop";
const code = "482913";
const origin = "https://login.vendor.example";
const input = { browserSessionId: "browser-1", sentBy: "email" } as const;
const owner = accessScopeForUser("better-auth:owner-1");
const member = {
  attributes: { workspaceId: owner.workspaceId },
  authenticator: "authjs",
  principalId: owner.userId,
  principalType: "user",
};
const question =
  'Enter the one-time code that login.vendor.example just sent by email for the saved login "Vendor".';
const filled = {
  filled: true,
  message:
    "The one-time code from the site was filled. Submit the code form now.",
};
const outsideOrigin = {
  filled: false,
  message:
    'The code page is not on the exact https origin the pinned login was saved with, so no code was asked for or filled. Delete the browser, then return status "failure" saying the code page is on another origin.',
};
const codePage: BrowserPageState = {
  frames: [],
  status: 200,
  text: "We emailed you a code.",
  timeOrigin: 5,
  title: "Check your email",
  url: `${origin}/verify`,
};

function siteInitiator(login: { id: string; origin: string } | undefined) {
  return sitePrincipal(
    { login, op: "create", site: "teemiq" },
    "owner@example.test",
    owner
  );
}

// A worker delegated by the site task's root session, which the code was
// sealed for.
function workerContext(
  ask: WorkflowToolContext["ask"],
  initiator: SessionAuthContext = siteInitiator({ id: "login-1", origin })
): WorkflowToolContext {
  const { messages: _messages, ...context } = toolContextFor({
    auth: { current: initiator, initiator },
    parentSessionId: "wrun_root",
    sessionId: "worker-1",
  });
  return {
    ...context,
    agent: () => {
      throw new Error("Delegation is outside this focused test.");
    },
    agents: {},
    ask,
  };
}

const resultSchema = z.strictObject({
  filled: z.boolean(),
  message: z.string(),
});

async function run(context: WorkflowToolContext) {
  return resultSchema.parse(await fillCodeFromSite.execute(input, context));
}

function answered(text: string) {
  return vi.fn<WorkflowToolContext["ask"]>(async () => ({
    status: "answered",
    text,
  }));
}

function sealed(value = code, sessionId = "wrun_root") {
  return sealSiteCode(authSecret, sessionId, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEveState();
  forgetInjectedValues("worker-1");
  // The timer never fires unless a test says so.
  mocks.sleep.mockReturnValue(new Promise<void>(() => undefined));
  mocks.requireWorkerScope.mockResolvedValue(owner);
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    createdAt: "2026-11-23T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-1",
  });
  mocks.inspectBrowserPages.mockResolvedValue([codePage]);
  mocks.currentKernelPageOrigin.mockResolvedValue(origin);
  mocks.assertFocus.mockResolvedValue(undefined);
  mocks.fill.mockResolvedValue(undefined);
  mocks.readVaultItem.mockResolvedValue({
    account: "",
    createdAt: "2026-11-23T00:00:00.000Z",
    id: "login-1",
    kind: "login",
    label: "Vendor",
    updatedAt: "2026-11-23T00:00:00.000Z",
  });
});

describe("fill_code_from_site", () => {
  it("asks the site for the code, then fills it without showing it", async () => {
    const ask = answered(sealed());

    const result = await run(workerContext(ask));

    expect(result).toEqual(filled);
    expect(ask).toHaveBeenCalledExactlyOnceWith({
      allowFreeform: true,
      display: "text",
      prompt: question,
      title: "One-time code",
    });
    expect(mocks.assertFocus).toHaveBeenCalledWith(
      expect.objectContaining({
        browserSessionId: "browser-1",
        expectedOrigin: origin,
      })
    );
    expect(mocks.sleep).toHaveBeenCalledExactlyOnceWith(20 * 60_000);
    expect(mocks.fill).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        browserSessionId: "browser-1",
        code,
        expectedOrigin: origin,
      })
    );
    expect(JSON.stringify(result)).not.toContain(code);
    expect(redactBrowserOutput("worker-1", "browser-1", `code ${code}`)).toBe(
      "code [vault value hidden]"
    );
  });

  it.each([
    ["another host of the login's site", "https://community.vendor.example"],
    ["the login's host over plain http", "http://login.vendor.example"],
    ["a look-alike host", "https://login.vendor.example.evil.test"],
  ])("asks nothing for a code page on %s", async (_case, pageOrigin) => {
    mocks.currentKernelPageOrigin.mockResolvedValue(pageOrigin);
    const ask = answered(sealed());

    const result = await run(workerContext(ask));

    expect(result).toEqual(outsideOrigin);
    expect(ask).not.toHaveBeenCalled();
    expect(mocks.assertFocus).not.toHaveBeenCalled();
  });

  it("fills nothing when the tab left the login's origin during the wait", async () => {
    mocks.currentKernelPageOrigin
      .mockResolvedValueOnce(origin)
      .mockResolvedValue("https://help.vendor.example");

    const result = await run(workerContext(answered(sealed())));

    expect(result).toEqual(outsideOrigin);
    expect(mocks.fill).not.toHaveBeenCalled();
  });

  it("refuses an http login origin even on its own page", async () => {
    mocks.currentKernelPageOrigin.mockResolvedValue("http://intranet.example");
    const ask = answered(sealed());

    const result = await run(
      workerContext(
        ask,
        siteInitiator({ id: "login-1", origin: "http://intranet.example" })
      )
    );

    expect(result).toEqual(outsideOrigin);
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([
    ["an interactive worker", member],
    ["a site task with no saved login", siteInitiator(undefined)],
  ])(
    "asks nothing and reads no vault or browser for %s",
    async (_case, initiator) => {
      const ask = answered(sealed());

      const result = await run(workerContext(ask, initiator));

      expect(result).toEqual({
        filled: false,
        message:
          "Only a site task pinned to a saved login can ask the site for a one-time code. Ask the coordinator for the code with `Needs user input:` instead.",
      });
      expect(ask).not.toHaveBeenCalled();
      expect(mocks.requireOwnedBrowserSession).not.toHaveBeenCalled();
      expect(mocks.inspectBrowserPages).not.toHaveBeenCalled();
      expect(mocks.readVaultItem).not.toHaveBeenCalled();
    }
  );

  it("asks nothing about a browser another worker opened", async () => {
    mocks.requireOwnedBrowserSession.mockRejectedValue(
      new Error("Browser session not found.")
    );
    const ask = answered(sealed());

    const result = await run(workerContext(ask));

    expect(result).toEqual({
      filled: false,
      message: "Browser session not found.",
    });
    expect(ask).not.toHaveBeenCalled();
    expect(mocks.inspectBrowserPages).not.toHaveBeenCalled();
  });

  it("stops at a block page without asking", async () => {
    mocks.inspectBrowserPages.mockResolvedValue([
      { ...codePage, text: "Enter the characters you see below" },
    ]);
    const ask = answered(sealed());

    const result = await run(workerContext(ask));

    expect(result.filled).toBe(false);
    expect(result.message).toMatch(/^BLOCKED: /u);
    expect(ask).not.toHaveBeenCalled();
    expect(mocks.assertFocus).not.toHaveBeenCalled();
  });

  it("asks only once a code field has focus", async () => {
    mocks.assertFocus.mockRejectedValue(
      new Error(
        "Focus the visible authenticator code field of the sign-in and retry."
      )
    );
    const ask = answered(sealed());

    const result = await run(workerContext(ask));

    expect(result).toEqual({
      filled: false,
      message:
        "Focus the visible code field of the sign-in with browser_act, then call fill_code_from_site again.",
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("stops waiting after 20 minutes and fills nothing", async () => {
    mocks.sleep.mockResolvedValue(undefined);
    const ask = vi.fn<WorkflowToolContext["ask"]>(
      () => new Promise<ToolAnswer>(() => undefined)
    );

    const result = await run(workerContext(ask));

    expect(result).toEqual({
      filled: false,
      message:
        'No code arrived within 20 minutes, so nothing was filled. Delete the browser, then return status "failure" saying the one-time code did not arrive in time.',
    });
    expect(mocks.fill).not.toHaveBeenCalled();
  });

  it("fills nothing when the question is withdrawn", async () => {
    const ask = vi.fn<WorkflowToolContext["ask"]>(async () => ({
      status: "cancelled",
    }));

    const result = await run(workerContext(ask));

    expect(result.filled).toBe(false);
    expect(result.message).toContain("no one-time code was received");
    expect(mocks.fill).not.toHaveBeenCalled();
  });

  it.each([
    ["a code typed straight into eve", code],
    ["a code sealed for another task", sealed(code, "wrun_other")],
  ])("fills nothing for %s", async (_case, answer) => {
    const result = await run(workerContext(answered(answer)));

    expect(result).toEqual({
      filled: false,
      message:
        'The answer was not a code the site sent for this task, so nothing was filled. Delete the browser, then return status "failure" saying the code could not be used.',
    });
    expect(mocks.fill).not.toHaveBeenCalled();
  });

  it("reports a browser that closed while it waited", async () => {
    mocks.inspectBrowserPages.mockResolvedValueOnce([codePage]);
    mocks.inspectBrowserPages.mockRejectedValueOnce(
      new NotFoundError(404, undefined, "not found", new Headers())
    );

    const result = await run(workerContext(answered(sealed())));

    expect(result).toEqual({
      filled: false,
      message:
        'The browser closed before the code could be filled. Return status "failure" saying the browser expired while waiting for the one-time code.',
    });
    expect(mocks.fill).not.toHaveBeenCalled();
  });

  it("keeps the code hidden and out of the result when a fill fails halfway", async () => {
    mocks.fill.mockRejectedValue(new Error(`Chromium rejected ${code}`));

    const result = await run(workerContext(answered(sealed())));

    expect(result.filled).toBe(false);
    expect(result.message).toMatch(/^The code could not be handled\./u);
    expect(JSON.stringify(result)).not.toContain(code);
    expect(redactBrowserOutput("worker-1", "browser-1", code)).toBe(
      "[vault value hidden]"
    );
    expect(redactBrowserOutput("worker-1", "browser-1", "4 8 2 9 1 3")).toBe(
      "[vault value hidden]"
    );
  });

  it("lets the fill find the code field again after the wait", async () => {
    await run(workerContext(answered(sealed())));

    expect(mocks.assertFocus).toHaveBeenCalledWith(
      expect.not.objectContaining({ refocus: true })
    );
    expect(mocks.fill).toHaveBeenCalledWith(
      expect.objectContaining({ refocus: true })
    );
  });

  it("keeps the code for one more try when the code page changed during the wait", async () => {
    mocks.fill.mockRejectedValue(
      new Error(
        "Focus the visible authenticator code field of the sign-in and retry."
      )
    );

    const result = await run(workerContext(answered(sealed())));

    expect(result).toEqual({
      filled: false,
      message:
        'The code page no longer shows a code field, so the code that arrived was not filled. If the page still asks for a code, focus its code field and call fill_code_from_site once more; otherwise delete the browser and return status "failure" saying the code page changed while the code was on its way.',
    });
  });

  it.each([
    "The code field did not keep the code that was filled.",
    "The code field has a different number of boxes than the code has characters.",
  ])("ends the task instead of asking again when %s", async (refusal) => {
    mocks.fill.mockRejectedValue(new Error(refusal));

    const result = await run(workerContext(answered(sealed())));

    expect(result).toEqual({
      filled: false,
      message:
        'The code field did not take the code, so it was not used. Asking again would fail the same way: delete the browser, then return status "failure" saying the code field did not accept the code.',
    });
  });
});
