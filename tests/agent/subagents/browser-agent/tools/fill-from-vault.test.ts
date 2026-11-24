import { beforeEach, describe, expect, it, vi } from "vitest";
import type { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import type { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import type {
  currentKernelPageOrigin,
  fillWithKernelNativeAutofill,
} from "@agent/subagents/browser-agent/lib/autofill/native";
import type { materializeAutofillClaims } from "@agent/subagents/browser-agent/lib/autofill/service";
import type {
  clearSiteTaskSignInOrigin,
  recordSiteTaskSignInOrigin,
} from "@db/services/sites";
import type { readVaultItem, readVaultSecret } from "@db/services/vault";
import { resetEveState } from "@tests/helpers/eve-state";
import { toolContextFor } from "@tests/helpers/tool-context";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  clearSignInOrigin: vi.fn<typeof clearSiteTaskSignInOrigin>(),
  currentKernelPageOrigin: vi.fn<typeof currentKernelPageOrigin>(),
  execute:
    vi.fn<
      () => Promise<{ readonly result?: unknown; readonly success: boolean }>
    >(),
  fill: vi.fn<typeof fillWithKernelNativeAutofill>(),
  materialize: vi.fn<typeof materializeAutofillClaims>(),
  readVaultItem: vi.fn<typeof readVaultItem>(),
  recordSignInOrigin: vi.fn<typeof recordSiteTaskSignInOrigin>(),
  requireOwnedBrowserSession: vi.fn<typeof requireOwnedBrowserSession>(),
  requireWorkerScope: vi.fn<typeof requireWorkerScope>(),
  retrieve: vi.fn<() => Promise<{ readonly profile_save_changes: boolean }>>(),
}));

vi.mock("eve/context", () => import("@tests/helpers/eve-state"));
vi.mock("@agent/subagents/browser-agent/lib/kernel", () => ({
  kernel: {
    browsers: {
      playwright: { execute: mocks.execute },
      retrieve: mocks.retrieve,
    },
  },
}));
vi.mock("@agent/subagents/browser-agent/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));
vi.mock("@agent/subagents/browser-agent/lib/owned-browser", () => ({
  requireOwnedBrowserSession: mocks.requireOwnedBrowserSession,
}));
vi.mock("@db/services/vault", () => ({
  readVaultItem: mocks.readVaultItem,
  readVaultSecret: vi.fn<typeof readVaultSecret>(),
}));
vi.mock("@db/services/sites", () => ({
  clearSiteTaskSignInOrigin: mocks.clearSignInOrigin,
  recordSiteTaskSignInOrigin: mocks.recordSignInOrigin,
}));
vi.mock("@agent/subagents/browser-agent/lib/autofill/native", () => ({
  currentKernelPageOrigin: mocks.currentKernelPageOrigin,
  fillWithKernelNativeAutofill: mocks.fill,
  nativeAutofillTokens: { login: ["username", "current-password"] },
}));
vi.mock("@agent/subagents/browser-agent/lib/autofill/service", () => ({
  materializeAutofillClaims: mocks.materialize,
}));

import fillFromVault from "@agent/subagents/browser-agent/tools/fill_from_vault";
import { SignInElsewhereRefusal } from "@agent/subagents/browser-agent/lib/autofill/sign-in-elsewhere";
import {
  forgetInjectedValues,
  redactBrowserOutput,
} from "@agent/subagents/browser-agent/lib/autofill/redaction";

const input = { browserSessionId: "browser-1", candidateId: "item-1" };
const context = toolContextFor({ sessionId: "worker-1" });
const owner = accessScopeForUser("better-auth:owner-1");
const member = {
  attributes: { workspaceId: owner.workspaceId },
  authenticator: "authjs",
  principalId: owner.userId,
  principalType: "user",
};

function siteInitiator(
  login: { alsoHosts?: string[]; id: string; origin: string } | undefined
) {
  return sitePrincipal(
    { login, op: "create", site: "teemiq" },
    "owner@example.test",
    owner
  );
}

function savedItem(kind: "address" | "contact" | "login" | "payment") {
  return {
    account: "",
    createdAt: "2026-11-22T00:00:00.000Z",
    hasSecret: true,
    id: "item-1",
    kind,
    label: "Saved",
    site: null,
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
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
  mocks.readVaultItem.mockResolvedValue(savedItem("login"));
  mocks.retrieve.mockResolvedValue({ profile_save_changes: true });
  mocks.recordSignInOrigin.mockResolvedValue(true);
  mocks.clearSignInOrigin.mockResolvedValue(undefined);
  mocks.currentKernelPageOrigin.mockResolvedValue("https://login.example.com");
  mocks.materialize.mockResolvedValue([
    {
      id: "00000000-0000-4000-8000-000000000001",
      token: "current-password",
      value: "correct-horse-battery",
    },
  ]);
  mocks.fill.mockResolvedValue({
    filledClaims: 1,
    origin: "https://login.example.com",
  });
  mocks.execute.mockResolvedValue({
    result: [
      {
        frames: [],
        status: 200,
        text: "",
        timeOrigin: 5,
        title: "Sign in",
        url: "https://login.example.com/",
      },
    ],
    success: true,
  });
});

describe("fill_from_vault", () => {
  it("fills a saved login and hides its values from later output", async () => {
    await expect(fillFromVault.execute(input, context)).resolves.toEqual({
      filledClaims: 1,
      kind: "login",
      origin: "https://login.example.com",
      success: true,
    });
    expect(mocks.fill).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "login" })
    );
    expect(
      redactBrowserOutput(
        "worker-1",
        "browser-1",
        'value="correct-horse-battery" and correct-horse-battery'
      )
    ).toBe('value="[hidden]" and [vault value hidden]');
  });

  it.each(["payment", "address", "contact"] as const)(
    "refuses a saved %s",
    async (kind) => {
      mocks.readVaultItem.mockResolvedValue(savedItem(kind));
      await expect(fillFromVault.execute(input, context)).rejects.toThrow(
        "Only saved logins can be filled for now."
      );
      expect(mocks.materialize).not.toHaveBeenCalled();
      expect(mocks.fill).not.toHaveBeenCalled();
    }
  );

  it("keeps values hidden when a fill fails halfway", async () => {
    mocks.fill.mockRejectedValue(
      new Error("Chromium said: input correct-horse-battery rejected")
    );

    await expect(fillFromVault.execute(input, context)).rejects.toThrow(
      "The saved login could not be filled."
    );
    expect(
      redactBrowserOutput("worker-1", "browser-1", "correct-horse-battery")
    ).toBe("[vault value hidden]");
  });

  it("passes only the injector's fixed messages through", async () => {
    mocks.fill.mockRejectedValueOnce(
      new Error(
        "Focus a visible username, email, phone, or current-password field and retry."
      )
    );
    await expect(fillFromVault.execute(input, context)).rejects.toThrow(
      "Focus a visible username, email, phone, or current-password field and retry."
    );

    mocks.materialize.mockRejectedValueOnce(
      new Error("This saved login is restricted to https://other.example.com.")
    );
    await expect(fillFromVault.execute(input, context)).rejects.toThrow(
      "This saved login is restricted to https://other.example.com."
    );

    mocks.currentKernelPageOrigin.mockRejectedValueOnce(
      new Error('page said "user@example.com" at node 12')
    );
    await expect(fillFromVault.execute(input, context)).rejects.toThrow(
      /^The saved login could not be filled\./u
    );
  });

  it("fills only the login a site task is pinned to, through later turns", async () => {
    const pinned = siteInitiator({
      id: "item-1",
      origin: "https://login.example.com",
    });
    // A later turn sent by the owner keeps the site task's pin.
    const laterTurn = toolContextFor({
      auth: { current: member, initiator: pinned },
      sessionId: "worker-1",
    });

    await expect(
      fillFromVault.execute({ ...input, candidateId: "item-2" }, laterTurn)
    ).rejects.toThrow(/^The selected vault item was not found\.$/u);
    expect(mocks.readVaultItem).not.toHaveBeenCalled();

    await expect(fillFromVault.execute(input, laterTurn)).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    expect(mocks.readVaultItem).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "item-1"
    );
  });

  it("records a page of the pinned login's site other than its origin, and fills nothing there", async () => {
    const pinned = siteInitiator({
      alsoHosts: ["chatgpt.example"],
      id: "item-1",
      origin: "https://login.example.com",
    });
    const siteTask = toolContextFor({
      auth: { current: pinned, initiator: pinned },
      parentSessionId: "wrun_task",
      sessionId: "worker-1",
    });

    for (const page of [
      "https://auth.example.com",
      "https://chatgpt.example",
    ]) {
      mocks.currentKernelPageOrigin.mockResolvedValueOnce(page);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each page is its own refused fill.
      await expect(fillFromVault.execute(input, siteTask)).rejects.toThrow(
        new SignInElsewhereRefusal("https://login.example.com").message
      );
    }
    expect(mocks.recordSignInOrigin.mock.calls).toEqual([
      [
        "teemiq",
        { userId: "user-1", workspaceId: "workspace-1" },
        "wrun_task",
        "https://auth.example.com",
      ],
      [
        "teemiq",
        { userId: "user-1", workspaceId: "workspace-1" },
        "wrun_task",
        "https://chatgpt.example",
      ],
    ]);
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(mocks.fill).not.toHaveBeenCalled();

    // On the saved origin nothing is recorded and the login is filled.
    await expect(fillFromVault.execute(input, siteTask)).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    expect(mocks.recordSignInOrigin).toHaveBeenCalledTimes(2);
  });

  it("sends the worker to the saved origin, and forgets the page once a fill there succeeds", async () => {
    const pinned = siteInitiator({
      id: "item-1",
      origin: "https://auth.vendor.example",
    });
    const siteTask = toolContextFor({
      auth: { current: pinned, initiator: pinned },
      parentSessionId: "wrun_task",
      sessionId: "worker-1",
    });
    mocks.currentKernelPageOrigin.mockResolvedValueOnce(
      "https://www.vendor.example"
    );

    // A sign-in form in the site's header is not the saved one: the refusal
    // names the saved origin and ends nothing yet.
    const refusal = fillFromVault.execute(input, siteTask);
    await expect(refusal).rejects.toThrow(SignInElsewhereRefusal);
    await expect(refusal).rejects.toThrow(
      /^This page is on the pinned login's site but not on https:\/\/auth\.vendor\.example, the exact origin the login was saved with, so nothing was filled\. .* Open https:\/\/auth\.vendor\.example with browser_navigate and sign in there\. If it shows no sign-in form, or you already did and the website led you back from it to a page like this one, delete the browser, /u
    );
    expect(mocks.recordSignInOrigin).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      { userId: "user-1", workspaceId: "workspace-1" },
      "wrun_task",
      "https://www.vendor.example"
    );
    expect(mocks.clearSignInOrigin).not.toHaveBeenCalled();

    mocks.currentKernelPageOrigin.mockResolvedValue(
      "https://auth.vendor.example"
    );
    mocks.fill.mockResolvedValueOnce({
      filledClaims: 1,
      origin: "https://auth.vendor.example",
    });
    await expect(fillFromVault.execute(input, siteTask)).resolves.toEqual({
      filledClaims: 1,
      kind: "login",
      origin: "https://auth.vendor.example",
      success: true,
    });
    expect(mocks.recordSignInOrigin).toHaveBeenCalledOnce();
    expect(mocks.clearSignInOrigin).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      { userId: "user-1", workspaceId: "workspace-1" },
      "wrun_task"
    );
  });

  it("keeps a fill on the saved origin when the page recorded before cannot be forgotten", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pinned = siteInitiator({
      id: "item-1",
      origin: "https://login.example.com",
    });
    mocks.clearSignInOrigin.mockRejectedValueOnce(
      new Error("Failed query: https://www.example.com")
    );

    await expect(
      fillFromVault.execute(
        input,
        toolContextFor({
          auth: { current: pinned, initiator: pinned },
          parentSessionId: "wrun_task",
          sessionId: "worker-1",
        })
      )
    ).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "[site] task sign-in page not cleared",
      { error: "Error", site: "teemiq" }
    );
  });

  it.each([
    [
      "Microsoft's sign-in host",
      "https://billing.microsoft.com",
      "https://login.microsoft.com",
    ],
    [
      "Apple's sign-in host",
      "https://appstoreconnect.apple.com",
      "https://idmsa.apple.com",
    ],
    [
      "a host written with a trailing dot",
      "https://login.example.com",
      "https://auth.example.com.",
    ],
  ])(
    "records no page on %s under the login's own domain, keeping the vault's refusal",
    async (_case, loginOrigin, page) => {
      const pinned = siteInitiator({ id: "item-1", origin: loginOrigin });
      const siteTask = toolContextFor({
        auth: { current: pinned, initiator: pinned },
        parentSessionId: "wrun_task",
        sessionId: "worker-1",
      });
      mocks.currentKernelPageOrigin.mockResolvedValue(page);
      mocks.materialize.mockRejectedValue(
        new Error(`This saved login is restricted to ${loginOrigin}.`)
      );

      await expect(fillFromVault.execute(input, siteTask)).rejects.toThrow(
        `This saved login is restricted to ${loginOrigin}.`
      );
      expect(mocks.recordSignInOrigin).not.toHaveBeenCalled();
      // The sign-in moved on from any page recorded before, so the task
      // reports none.
      expect(mocks.clearSignInOrigin).toHaveBeenCalledExactlyOnceWith(
        "teemiq",
        { userId: "user-1", workspaceId: "workspace-1" },
        "wrun_task"
      );
      expect(mocks.fill).not.toHaveBeenCalled();
    }
  );

  it("leaves the vault's refusal of a page outside the login's site as it was", async () => {
    const pinned = siteInitiator({
      id: "item-1",
      origin: "https://login.example.com",
    });
    const siteTask = toolContextFor({
      auth: { current: pinned, initiator: pinned },
      parentSessionId: "wrun_task",
      sessionId: "worker-1",
    });
    mocks.currentKernelPageOrigin.mockResolvedValue("https://pay.stripe.com");
    mocks.materialize.mockRejectedValue(
      new Error("This saved login is restricted to https://login.example.com.")
    );

    await expect(fillFromVault.execute(input, siteTask)).rejects.toThrow(
      /^This saved login is restricted to https:\/\/login\.example\.com\.$/u
    );
    // Stripe says nothing of where the site signs in, so a page recorded
    // before stays.
    expect(mocks.recordSignInOrigin).not.toHaveBeenCalled();
    expect(mocks.clearSignInOrigin).not.toHaveBeenCalled();
    expect(mocks.fill).not.toHaveBeenCalled();
  });

  it("fills nothing in a site task without a pin", async () => {
    const unpinned = siteInitiator(undefined);
    const siteTask = toolContextFor({
      auth: { current: unpinned, initiator: unpinned },
      sessionId: "worker-1",
    });

    await expect(fillFromVault.execute(input, siteTask)).rejects.toThrow(
      /^The selected vault item was not found\.$/u
    );
    expect(mocks.readVaultItem).not.toHaveBeenCalled();
    expect(mocks.fill).not.toHaveBeenCalled();
  });

  it("still fills any saved login for a member", async () => {
    const memberTurn = toolContextFor({
      auth: { current: member, initiator: member },
      sessionId: "worker-1",
    });

    await expect(
      fillFromVault.execute({ ...input, candidateId: "item-2" }, memberTurn)
    ).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(mocks.readVaultItem).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "item-2"
    );
  });

  it("requires a writable browser for a login", async () => {
    mocks.retrieve.mockResolvedValue({ profile_save_changes: false });
    await expect(fillFromVault.execute(input, context)).rejects.toThrow(
      /save_changes: true/u
    );
    expect(mocks.fill).not.toHaveBeenCalled();
  });
});
