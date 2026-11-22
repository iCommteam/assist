import { beforeEach, describe, expect, it, vi } from "vitest";
import type { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import type { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import type {
  currentKernelPageOrigin,
  fillWithKernelNativeAutofill,
} from "@agent/subagents/browser-agent/lib/autofill/native";
import type { materializeAutofillClaims } from "@agent/subagents/browser-agent/lib/autofill/service";
import type { readVaultItem, readVaultSecret } from "@db/services/vault";
import { resetEveState } from "@tests/helpers/eve-state";
import { toolContextFor } from "@tests/helpers/tool-context";

const mocks = vi.hoisted(() => ({
  currentKernelPageOrigin: vi.fn<typeof currentKernelPageOrigin>(),
  execute:
    vi.fn<
      () => Promise<{ readonly result?: unknown; readonly success: boolean }>
    >(),
  fill: vi.fn<typeof fillWithKernelNativeAutofill>(),
  materialize: vi.fn<typeof materializeAutofillClaims>(),
  readVaultItem: vi.fn<typeof readVaultItem>(),
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
vi.mock("@agent/subagents/browser-agent/lib/autofill/native", () => ({
  currentKernelPageOrigin: mocks.currentKernelPageOrigin,
  fillWithKernelNativeAutofill: mocks.fill,
  nativeAutofillTokens: { login: ["username", "current-password"] },
}));
vi.mock("@agent/subagents/browser-agent/lib/autofill/service", () => ({
  materializeAutofillClaims: mocks.materialize,
}));

import fillFromVault from "@agent/subagents/browser-agent/tools/fill_from_vault";
import {
  forgetInjectedValues,
  redactBrowserOutput,
} from "@agent/subagents/browser-agent/lib/autofill/redaction";

const input = { browserSessionId: "browser-1", candidateId: "item-1" };
const context = toolContextFor({ sessionId: "worker-1" });

function savedItem(kind: "address" | "contact" | "login" | "payment") {
  return {
    account: "",
    createdAt: "2026-11-22T00:00:00.000Z",
    hasSecret: true,
    id: "item-1",
    kind,
    label: "Saved",
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

  it("requires a writable browser for a login", async () => {
    mocks.retrieve.mockResolvedValue({ profile_save_changes: false });
    await expect(fillFromVault.execute(input, context)).rejects.toThrow(
      /save_changes: true/u
    );
    expect(mocks.fill).not.toHaveBeenCalled();
  });
});
