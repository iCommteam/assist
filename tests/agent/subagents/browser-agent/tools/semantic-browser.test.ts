import type * as EveTools from "eve/tools";
import type { LoopToolExecutionResult } from "@onkernel/browser-loop";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import type { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import type { executeBrowserLoopTool } from "@agent/subagents/browser-agent/lib/semantic-loop";
import {
  dynamicContextFor,
  dynamicTool,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { resetEveState } from "@tests/helpers/eve-state";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { toolContextFor } from "@tests/helpers/tool-context";

const mocks = vi.hoisted(() => ({
  execute:
    vi.fn<
      (
        sessionId: string,
        body: { readonly code: string; readonly timeout_sec: number },
        options: { readonly signal?: AbortSignal }
      ) => Promise<{ readonly result?: unknown; readonly success: boolean }>
    >(),
  executeBrowserLoopTool: vi.fn<typeof executeBrowserLoopTool>(),
  requireOwnedBrowserSession: vi.fn<typeof requireOwnedBrowserSession>(),
  requireWorkerScope: vi.fn<typeof requireWorkerScope>(),
}));

vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);
vi.mock("eve/context", () => import("@tests/helpers/eve-state"));
vi.mock("@agent/subagents/browser-agent/lib/kernel", () => ({
  kernel: { browsers: { playwright: { execute: mocks.execute } } },
}));
vi.mock("@agent/subagents/browser-agent/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));
vi.mock("@agent/subagents/browser-agent/lib/owned-browser", () => ({
  requireOwnedBrowserSession: mocks.requireOwnedBrowserSession,
}));
vi.mock("@agent/subagents/browser-agent/lib/semantic-loop", async () => ({
  executeBrowserLoopTool: mocks.executeBrowserLoopTool,
  modelText: (output: LoopToolExecutionResult) =>
    output.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n"),
}));

import semanticBrowser from "@agent/subagents/browser-agent/tools/semantic_browser";
import {
  forgetInjectedValues,
  markCodeFilledBrowser,
  rememberInjectedValues,
} from "@agent/subagents/browser-agent/lib/autofill/redaction";

const clearPage = {
  frames: [],
  status: 200,
  text: "Example Domain",
  timeOrigin: 1_000,
  title: "Example Domain",
  url: "https://example.com/",
};

function loopText(text: string): LoopToolExecutionResult {
  return { content: [{ text, type: "text" }], details: { statusText: "ok" } };
}

async function tools() {
  return evaluateDynamic(semanticBrowser, dynamicContextFor());
}

async function call(
  name: string,
  input: Readonly<
    Record<string, string | readonly Readonly<Record<string, string>>[]>
  >,
  auth?: EveTools.ToolContext["session"]["auth"]
) {
  const tool = dynamicTool(await tools(), name);
  return tool.execute(
    { session_id: "browser-1", ...input },
    toolContextFor({ auth, sessionId: "worker-1", toolName: name })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEveState();
  forgetInjectedValues("worker-1");
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    createdAt: "2026-11-22T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-1",
  });
  mocks.execute.mockResolvedValue({ result: [clearPage], success: true });
  mocks.executeBrowserLoopTool.mockResolvedValue(loopText("snapshot"));
});

describe("semantic browser tools", () => {
  it("offers the semantic tools and navigation, but no Playwright code", async () => {
    const resolved = await tools();
    expect(Object.keys(resolved ?? {}).toSorted()).toEqual([
      "browser_act",
      "browser_find",
      "browser_navigate",
      "browser_snapshot",
      "browser_text",
      "browser_wait_for",
    ]);
  });

  it("refuses to navigate to an Amazon site without touching the browser", async () => {
    await expect(
      call("browser_navigate", { url: "https://www.amazon.com/" })
    ).rejects.toThrow(/www\.amazon\.com is an Amazon site.*blocked by policy/u);
    await expect(
      call("browser_navigate", { url: "https://amzn.to/x" })
    ).rejects.toThrow(/blocked by policy/u);
    expect(mocks.executeBrowserLoopTool).not.toHaveBeenCalled();

    await call("browser_navigate", { url: "back" });
    await call("browser_navigate", { url: "https://example.org/" });
    expect(mocks.executeBrowserLoopTool).toHaveBeenCalledTimes(2);
  });

  it("lets a pinned site task navigate only inside its login's site", async () => {
    const owner = accessScopeForUser("better-auth:owner-1");
    const initiator = sitePrincipal(
      {
        login: { id: "login-1", origin: "https://login.vendor.com" },
        op: "create",
        site: "teemiq",
      },
      "owner@example.test",
      owner
    );
    // The owner writing into the task later does not lift the fence.
    const member = {
      attributes: { workspaceId: owner.workspaceId },
      authenticator: "authjs",
      principalId: owner.userId,
      principalType: "user",
    };
    const auth = { current: member, initiator };

    await expect(
      call("browser_navigate", { url: "https://attacker.example/?d=x" }, auth)
    ).rejects.toThrow(/attacker\.example is outside vendor\.com/u);
    expect(mocks.executeBrowserLoopTool).not.toHaveBeenCalled();

    await call(
      "browser_navigate",
      { url: "https://billing.vendor.com/invoices" },
      auth
    );
    await call("browser_navigate", { url: "back" }, auth);
    expect(mocks.executeBrowserLoopTool).toHaveBeenCalledTimes(2);

    // A supplier that bills through Stripe links its hosted invoice page.
    await call(
      "browser_navigate",
      { url: "https://invoice.stripe.com/i/acct_1/live_abc" },
      auth
    );
    expect(mocks.executeBrowserLoopTool).toHaveBeenCalledTimes(3);
    await expect(
      call("browser_navigate", { url: "https://dashboard.stripe.com/" }, auth)
    ).rejects.toThrow(/dashboard\.stripe\.com is outside vendor\.com/u);
    expect(mocks.executeBrowserLoopTool).toHaveBeenCalledTimes(3);
  });

  it("returns the page result after a clear page check", async () => {
    await expect(call("browser_snapshot", {})).resolves.toEqual(
      loopText("snapshot")
    );
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("replaces a blocked page with BLOCKED and refuses every later action", async () => {
    mocks.executeBrowserLoopTool.mockResolvedValue(
      loopText("Robot Check: enter the characters you see below")
    );
    mocks.execute.mockResolvedValue({
      result: [{ ...clearPage, title: "Robot Check" }],
      success: true,
    });

    const output = await call("browser_act", {
      steps: [{ ref: "e1", type: "click" }],
    });
    expect(JSON.stringify(output)).toContain("BLOCKED: example.com");
    expect(JSON.stringify(output)).not.toContain("enter the characters");

    await expect(call("browser_snapshot", {})).rejects.toThrow(
      /already stopped at a block/u
    );
    expect(mocks.executeBrowserLoopTool).toHaveBeenCalledOnce();
  });

  it("withholds an Amazon page a click landed on", async () => {
    mocks.execute
      .mockResolvedValueOnce({
        result: [{ ...clearPage, url: "https://www.amazon.co.uk/gp/cart" }],
        success: true,
      })
      .mockResolvedValueOnce({ result: true, success: true });

    const output = await call("browser_act", {
      steps: [{ ref: "e1", type: "click" }],
    });
    expect(JSON.stringify(output)).toContain("REFUSED BY POLICY");
    expect(JSON.stringify(output)).not.toContain("snapshot");
    await expect(call("browser_snapshot", {})).resolves.toEqual(
      loopText("snapshot")
    );
  });

  it("hides vault values from results and errors", async () => {
    rememberInjectedValues("worker-1", "browser-1", ["s3cret-password"]);
    mocks.executeBrowserLoopTool.mockResolvedValueOnce(
      loopText('textbox "Password" value="s3cret-password"')
    );

    expect(JSON.stringify(await call("browser_snapshot", {}))).not.toContain(
      "s3cret-password"
    );

    mocks.executeBrowserLoopTool.mockRejectedValueOnce(
      new Error("fill failed near s3cret-password")
    );
    await expect(call("browser_snapshot", {})).rejects.toThrow(
      "fill failed near [vault value hidden]"
    );
  });

  it("replaces page images with a note while the page holds a filled code", async () => {
    markCodeFilledBrowser("browser-1");
    mocks.executeBrowserLoopTool.mockResolvedValueOnce({
      content: [
        { text: "snapshot", type: "text" },
        { data: "cG5n", mimeType: "image/png", type: "image" },
      ],
      details: { statusText: "ok" },
    });

    expect(await call("browser_snapshot", {})).toEqual({
      content: [
        { text: "snapshot", type: "text" },
        {
          text: "The screenshot was withheld because this browser may still show a filled one-time code. Use browser_snapshot; screenshots return once the code page is gone.",
          type: "text",
        },
      ],
      details: { statusText: "ok" },
    });
  });
});
