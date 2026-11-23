import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import type { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import type {
  currentKernelPageOrigin,
  fillKernelOneTimeCode,
} from "@agent/subagents/browser-agent/lib/autofill/native";
import type { readVaultItem, readVaultSecret } from "@db/services/vault";
import { resetEveState } from "@tests/helpers/eve-state";
import { toolContextFor } from "@tests/helpers/tool-context";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { serializeLoginVaultPayload } from "@shared/vault/schema";

const mocks = vi.hoisted(() => ({
  currentKernelPageOrigin: vi.fn<typeof currentKernelPageOrigin>(),
  execute:
    vi.fn<
      () => Promise<{ readonly result?: unknown; readonly success: boolean }>
    >(),
  fill: vi.fn<typeof fillKernelOneTimeCode>(),
  readVaultItem: vi.fn<typeof readVaultItem>(),
  readVaultSecret: vi.fn<typeof readVaultSecret>(),
  requireOwnedBrowserSession: vi.fn<typeof requireOwnedBrowserSession>(),
  requireWorkerScope: vi.fn<typeof requireWorkerScope>(),
}));

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
vi.mock("@db/services/vault", () => ({
  hasVaultSecret: vi.fn<() => Promise<boolean>>(),
  listVaultItems: vi.fn<() => Promise<never[]>>(),
  readVaultItem: mocks.readVaultItem,
  readVaultSecret: mocks.readVaultSecret,
}));
vi.mock("@agent/subagents/browser-agent/lib/autofill/native", () => ({
  currentKernelPageOrigin: mocks.currentKernelPageOrigin,
  fillKernelOneTimeCode: mocks.fill,
}));

import fillTotpFromVault from "@agent/subagents/browser-agent/tools/fill_totp_from_vault";
import {
  forgetInjectedValues,
  redactBrowserOutput,
} from "@agent/subagents/browser-agent/lib/autofill/redaction";

// RFC 6238's SHA1 seed: at 59 s its six-digit code is 287082.
const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const code = "287082";
const origin = "https://login.vendor.example";
const input = { browserSessionId: "browser-1", candidateId: "item-1" };
const context = toolContextFor({ sessionId: "worker-1" });
const owner = accessScopeForUser("better-auth:owner-1");
const member = {
  attributes: { workspaceId: owner.workspaceId },
  authenticator: "authjs",
  principalId: owner.userId,
  principalType: "user",
};
const filled = {
  message:
    "The current authenticator code was filled. Submit the code form now, before the code changes.",
  success: true,
};

function siteContext(login: { id: string; origin: string } | undefined) {
  const initiator = sitePrincipal(
    { login, op: "create", site: "teemiq" },
    "owner@example.test",
    owner
  );
  // A later turn sent by the owner keeps the site task's pin.
  return toolContextFor({
    auth: { current: member, initiator },
    sessionId: "worker-1",
  });
}

function savedItem(kind: "login" | "payment") {
  return {
    account: "",
    createdAt: "2026-11-22T00:00:00.000Z",
    hasSecret: true,
    id: "item-1",
    kind,
    label: "Vendor",
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
}

function savedLogin(withKey: boolean) {
  return serializeLoginVaultPayload({
    authentication: {
      password: "correct-horse-battery",
      totp: withKey
        ? { algorithm: "SHA1", digits: 6, period: 30, secret: seed }
        : undefined,
      type: "password",
    },
    identifier: { type: "email", value: "ap@example.com" },
    kind: "login",
    origin,
    version: 2,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(59_000);
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
  mocks.readVaultSecret.mockResolvedValue(savedLogin(true));
  mocks.currentKernelPageOrigin.mockResolvedValue(origin);
  mocks.fill.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue({
    result: [
      {
        frames: [],
        status: 200,
        text: "",
        timeOrigin: 5,
        title: "Two-step verification",
        url: `${origin}/mfa`,
      },
    ],
    success: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fill_totp_from_vault", () => {
  it("fills the current code without returning it, and hides it afterwards", async () => {
    const result = await fillTotpFromVault.execute(input, context);

    expect(result).toEqual(filled);
    expect(JSON.stringify(result)).not.toContain(code);
    expect(mocks.fill).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        browserSessionId: "browser-1",
        code,
        expectedOrigin: origin,
      })
    );
    expect(
      redactBrowserOutput(
        "worker-1",
        "browser-1",
        `value="${code}" and ${code}`
      )
    ).toBe('value="[hidden]" and [vault value hidden]');
  });

  it("keeps the code hidden and out of the error when a fill fails halfway", async () => {
    mocks.fill.mockRejectedValue(new Error(`Chromium rejected ${code}`));

    await expect(fillTotpFromVault.execute(input, context)).rejects.toThrow(
      /^The authenticator code could not be filled\./u
    );
    await expect(fillTotpFromVault.execute(input, context)).rejects.not.toThrow(
      code
    );
    expect(redactBrowserOutput("worker-1", "browser-1", code)).toBe(
      "[vault value hidden]"
    );
  });

  it("passes only the injector's fixed messages through", async () => {
    mocks.fill.mockRejectedValueOnce(
      new Error(
        "Focus the visible authenticator code field of the sign-in and retry."
      )
    );
    await expect(fillTotpFromVault.execute(input, context)).rejects.toThrow(
      /^Focus the visible authenticator code field of the sign-in and retry\.$/u
    );

    mocks.currentKernelPageOrigin.mockRejectedValueOnce(
      new Error('page said "ap@example.com" at node 12')
    );
    await expect(fillTotpFromVault.execute(input, context)).rejects.toThrow(
      /^The authenticator code could not be filled\./u
    );
  });

  it("computes no code on another website", async () => {
    mocks.currentKernelPageOrigin.mockResolvedValue("https://evil.example");

    await expect(fillTotpFromVault.execute(input, context)).rejects.toThrow(
      /^This saved login is restricted to https:\/\/login\.vendor\.example\.$/u
    );
    expect(mocks.fill).not.toHaveBeenCalled();
    expect(redactBrowserOutput("worker-1", "browser-1", code)).toBe(code);
  });

  it("refuses a login without an authenticator setup key", async () => {
    mocks.readVaultSecret.mockResolvedValue(savedLogin(false));

    await expect(fillTotpFromVault.execute(input, context)).rejects.toThrow(
      /^This saved login has no authenticator setup key\.$/u
    );
    expect(mocks.fill).not.toHaveBeenCalled();
  });

  it("refuses an item that is not a login before reading its secret", async () => {
    mocks.readVaultItem.mockResolvedValue(savedItem("payment"));

    await expect(fillTotpFromVault.execute(input, context)).rejects.toThrow(
      "Only a saved login can hold an authenticator setup key."
    );
    expect(mocks.readVaultSecret).not.toHaveBeenCalled();
    expect(mocks.fill).not.toHaveBeenCalled();
  });

  it("refuses a browser this worker did not create before reading the vault", async () => {
    mocks.requireOwnedBrowserSession.mockRejectedValue(
      new Error("Browser session not found.")
    );

    await expect(fillTotpFromVault.execute(input, context)).rejects.toThrow(
      "Browser session not found."
    );
    expect(mocks.readVaultItem).not.toHaveBeenCalled();
  });

  it("fills only the login a site task is pinned to", async () => {
    const pinned = siteContext({ id: "item-1", origin });

    await expect(
      fillTotpFromVault.execute({ ...input, candidateId: "item-2" }, pinned)
    ).rejects.toThrow(/^The selected vault item was not found\.$/u);
    expect(mocks.readVaultItem).not.toHaveBeenCalled();

    await expect(fillTotpFromVault.execute(input, pinned)).resolves.toEqual(
      filled
    );
  });

  it("fills nothing in a site task without a pin", async () => {
    await expect(
      fillTotpFromVault.execute(input, siteContext(undefined))
    ).rejects.toThrow(/^The selected vault item was not found\.$/u);
    expect(mocks.readVaultItem).not.toHaveBeenCalled();
    expect(mocks.fill).not.toHaveBeenCalled();
  });
});
