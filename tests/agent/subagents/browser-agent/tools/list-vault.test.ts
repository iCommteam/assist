import { beforeEach, describe, expect, it, vi } from "vitest";
import type { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import type { readVaultItems } from "@db/services/vault";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { toolContextFor } from "@tests/helpers/tool-context";

const mocks = vi.hoisted(() => ({
  readVaultItems: vi.fn<typeof readVaultItems>(),
  requireWorkerScope: vi.fn<typeof requireWorkerScope>(),
}));

vi.mock("@agent/subagents/browser-agent/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));
vi.mock("@db/services/vault", () => ({
  readVaultItems: mocks.readVaultItems,
}));

import listVault from "@agent/subagents/browser-agent/tools/list_vault";

const owner = accessScopeForUser("better-auth:owner-1");
const member = {
  attributes: { workspaceId: owner.workspaceId },
  authenticator: "authjs",
  principalId: owner.userId,
  principalType: "user",
};

function savedItem(id: string, kind: "login" | "payment") {
  return {
    account: `${id} hint`,
    createdAt: "2026-11-22T00:00:00.000Z",
    hasSecret: true,
    id,
    kind,
    label: `Saved ${id}`,
    site: null,
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
}

function siteInitiator(login: { id: string; origin: string } | undefined) {
  return sitePrincipal(
    { login, op: "create", site: "teemiq" },
    "owner@example.test",
    owner
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkerScope.mockResolvedValue(owner);
  mocks.readVaultItems.mockResolvedValue([
    savedItem("login-1", "login"),
    savedItem("login-2", "login"),
    savedItem("card-1", "payment"),
  ]);
});

describe("list_vault", () => {
  it("lists every saved login for a member", async () => {
    const handles = await listVault.execute(
      {},
      toolContextFor({
        auth: { current: member, initiator: member },
        sessionId: "worker-1",
      })
    );

    expect(handles).toEqual([
      {
        account: "login-1 hint",
        available: true,
        handle: "login-1",
        kind: "login",
        label: "Saved login-1",
      },
      {
        account: "login-2 hint",
        available: true,
        handle: "login-2",
        kind: "login",
        label: "Saved login-2",
      },
    ]);
  });

  it("shows a pinned site task only its login, through later turns", async () => {
    const initiator = siteInitiator({
      id: "login-2",
      origin: "https://login.vendor.example",
    });

    const handles = await listVault.execute(
      {},
      toolContextFor({
        auth: { current: member, initiator },
        sessionId: "worker-1",
      })
    );

    expect(handles).toEqual([
      expect.objectContaining({ handle: "login-2", label: "Saved login-2" }),
    ]);
  });

  it("shows nothing when the pin names no saved login", async () => {
    const initiator = siteInitiator({
      id: "card-1",
      origin: "https://login.vendor.example",
    });

    await expect(
      listVault.execute(
        {},
        toolContextFor({ auth: { current: initiator, initiator } })
      )
    ).resolves.toEqual([]);
  });

  it("shows a site task without a pin no saved login at all", async () => {
    const initiator = siteInitiator(undefined);

    await expect(
      listVault.execute(
        {},
        toolContextFor({ auth: { current: initiator, initiator } })
      )
    ).resolves.toEqual([]);
    expect(mocks.readVaultItems).not.toHaveBeenCalled();
  });
});
