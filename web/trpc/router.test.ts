import type * as KernelSdk from "@onkernel/sdk";
import { NotFoundError } from "@onkernel/sdk";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Allowlist from "@db/services/auth/allowlist";
import * as BrowserTraces from "@db/services/browser-traces";
import * as Chats from "@db/services/chats";
import * as Vault from "@db/services/vault";
import * as Whatsapp from "@db/services/whatsapp";
import * as WhatsappLinks from "@db/services/whatsapp-links";
import * as Loopback from "@shared/environment/loopback";
import * as WhatsappEnvironment from "@shared/environment/whatsapp";
import { kernelProfileNameForLogin } from "@shared/browser/kernel-profile";
import type { AccessScope } from "@shared/identity/access-scope";
import { appRouter } from "./router";

const kernelMocks = vi.hoisted(() => ({
  deleteProfile:
    vi.fn<
      (
        idOrName: string,
        options: { readonly signal: AbortSignal }
      ) => Promise<void>
    >(),
}));

vi.mock("@onkernel/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof KernelSdk>()),
  default: class {
    profiles = { delete: kernelMocks.deleteProfile };
  },
}));

const listBrowserTracesMock = vi.spyOn(BrowserTraces, "listBrowserTraces");
const saveChatMock = vi.spyOn(Chats, "saveChat");
const readVaultItemMock = vi.spyOn(Vault, "readVaultItem");
const deleteVaultItemMock = vi.spyOn(Vault, "deleteVaultItem");

const scope = {
  userId: "user-1",
  workspaceId: "workspace-1",
} satisfies AccessScope;

describe("appRouter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the authenticated scope and cursor to the trace history", async () => {
    listBrowserTracesMock.mockResolvedValue({ nextCursor: null, traces: [] });

    await appRouter
      .createCaller({ origin: "https://example.com", scope })
      .traces.list({ cursor: "next-page" });

    expect(listBrowserTracesMock).toHaveBeenCalledWith(scope, "next-page");
  });

  it("rejects invalid chat writes before persistence", async () => {
    await expect(
      appRouter
        .createCaller({ origin: "https://example.com", scope })
        .chats.save({ sessionId: "" })
    ).rejects.toThrow("Too small");
    expect(saveChatMock).not.toHaveBeenCalled();
  });

  it("sends a generic message, no stack and no path for a server failure", async () => {
    listBrowserTracesMock.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.7:5432 at /srv/app/db.ts")
    );

    const response = await fetchRequestHandler({
      createContext: () => ({ origin: "https://example.com", scope }),
      endpoint: "/api/trpc",
      req: new Request(
        `https://example.com/api/trpc/traces.list?input=${encodeURIComponent("{}")}`
      ),
      router: appRouter,
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("The request failed.");
    expect(body).not.toContain("10.0.0.7");
    expect(body).not.toContain("/srv/app");
    expect(body).not.toContain("stack");
    expect(body).not.toContain("traces.list");
  });

  it("keeps the message of a client error", async () => {
    const response = await fetchRequestHandler({
      createContext: () => ({ origin: "https://example.com", scope }),
      endpoint: "/api/trpc",
      req: new Request("https://example.com/api/trpc/chats.save", {
        body: JSON.stringify({ sessionId: "" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      router: appRouter,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Too small");
  });

  describe("vault.remove", () => {
    const caller = () =>
      appRouter.createCaller({ origin: "https://example.com", scope });

    beforeEach(() => {
      readVaultItemMock.mockResolvedValue(vaultItem("login"));
      deleteVaultItemMock.mockResolvedValue(true);
      kernelMocks.deleteProfile.mockResolvedValue();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it("deletes a removed login's own browser profile after the vault item", async () => {
      await expect(caller().vault.remove({ id: "login-1" })).resolves.toBe(
        true
      );

      expect(deleteVaultItemMock).toHaveBeenCalledExactlyOnceWith(
        scope,
        "login-1"
      );
      expect(kernelMocks.deleteProfile).toHaveBeenCalledExactlyOnceWith(
        kernelProfileNameForLogin("workspace-1", "login-1"),
        expect.anything()
      );
      expect(
        kernelMocks.deleteProfile.mock.calls[0]?.[1].signal
      ).toBeInstanceOf(AbortSignal);
      expect(
        deleteVaultItemMock.mock.invocationCallOrder[0] ?? Infinity
      ).toBeLessThan(
        kernelMocks.deleteProfile.mock.invocationCallOrder[0] ?? 0
      );
    });

    it("leaves Kernel alone when nothing was removed or the item is not a login", async () => {
      deleteVaultItemMock.mockResolvedValueOnce(false);
      await expect(caller().vault.remove({ id: "login-1" })).resolves.toBe(
        false
      );
      readVaultItemMock.mockResolvedValueOnce(vaultItem("address"));
      await expect(caller().vault.remove({ id: "address-1" })).resolves.toBe(
        true
      );
      readVaultItemMock.mockResolvedValueOnce(undefined);
      await caller().vault.remove({ id: "missing" });

      expect(kernelMocks.deleteProfile).not.toHaveBeenCalled();
    });

    it("removes the login even when Kernel cannot delete its profile", async () => {
      kernelMocks.deleteProfile.mockRejectedValueOnce(
        new NotFoundError(404, undefined, "Profile not found", new Headers())
      );
      await expect(caller().vault.remove({ id: "login-1" })).resolves.toBe(
        true
      );
      expect(console.warn).not.toHaveBeenCalled();

      kernelMocks.deleteProfile.mockRejectedValueOnce(
        new TypeError("fetch failed: kernel.example/profiles/openinstinct-x")
      );
      await expect(caller().vault.remove({ id: "login-1" })).resolves.toBe(
        true
      );
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        "[vault] login browser profile could not be deleted",
        { error: "TypeError" }
      );
    });
  });
});

describe("WhatsApp access", () => {
  const whatsappScope = {
    userId: "better-auth:user-1",
    workspaceId: "workspace-1",
  } satisfies AccessScope;
  const whatsapp = () =>
    appRouter.createCaller({
      origin: "https://example.com",
      scope: whatsappScope,
    }).whatsapp;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Whatsapp, "lockWhatsapp").mockResolvedValue();
    vi.spyOn(Whatsapp, "unlockWhatsapp").mockResolvedValue();
    vi.spyOn(Loopback, "postWhatsappLoopback").mockResolvedValue(
      new Response(null, { status: 204 })
    );
    vi.spyOn(Allowlist, "isAdminMember").mockResolvedValue(false);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("locks the member's own WhatsApp and ends their full chats, and turns it back on", async () => {
    await whatsapp().lock();
    expect(Whatsapp.lockWhatsapp).toHaveBeenCalledWith("user-1", "web");
    expect(Loopback.postWhatsappLoopback).toHaveBeenCalledWith(
      "/internal/whatsapp/end",
      { member: "better-auth:user-1" }
    );

    await whatsapp().unlock();
    expect(Whatsapp.unlockWhatsapp).toHaveBeenCalledWith("user-1");
  });

  it("keeps the lock when the chats cannot be ended", async () => {
    vi.mocked(Loopback.postWhatsappLoopback).mockRejectedValue(
      new TypeError("fetch failed")
    );
    await expect(whatsapp().lock()).resolves.toBeUndefined();
    expect(Whatsapp.lockWhatsapp).toHaveBeenCalledOnce();
  });

  it("lets only an administrator lock everyone, or turn everyone back on", async () => {
    await expect(whatsapp().lockEveryone()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(whatsapp().unlockEveryone()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(Whatsapp.lockWhatsapp).not.toHaveBeenCalled();
    expect(Whatsapp.unlockWhatsapp).not.toHaveBeenCalled();
    expect(Allowlist.isAdminMember).toHaveBeenCalledWith("user-1");

    vi.mocked(Allowlist.isAdminMember).mockResolvedValue(true);
    await whatsapp().lockEveryone();
    expect(Whatsapp.lockWhatsapp).toHaveBeenCalledWith("*", "admin");
    expect(Loopback.postWhatsappLoopback).toHaveBeenCalledWith(
      "/internal/whatsapp/end",
      { member: "*" }
    );
    await whatsapp().unlockEveryone();
    expect(Whatsapp.unlockWhatsapp).toHaveBeenCalledWith("*");
  });
});

describe("Connect WhatsApp", () => {
  const linkId = "00000000-0000-4000-8000-000000000001";
  const memberScope = {
    userId: "better-auth:user-1",
    workspaceId: "workspace-1",
  } satisfies AccessScope;
  const whatsapp = () =>
    appRouter.createCaller({
      origin: "https://example.com",
      scope: memberScope,
    }).whatsapp;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(WhatsappEnvironment, "whatsappChannelConfigured").mockReturnValue(
      true
    );
    vi.spyOn(Allowlist, "emailOfUser").mockResolvedValue("Member@Example.test");
    vi.spyOn(Allowlist, "enrolledTeamMemberId").mockResolvedValue("user-1");
    vi.spyOn(Allowlist, "isAdminMember").mockResolvedValue(false);
    vi.spyOn(WhatsappLinks, "createWhatsappLinkCode").mockResolvedValue({
      code: "ABCD2345",
      expiresAt: new Date("2026-11-25T12:10:00.000Z"),
    });
    vi.spyOn(WhatsappLinks, "cancelWhatsappLinkCode").mockResolvedValue();
    vi.spyOn(WhatsappLinks, "whatsappLinkCodeLive").mockResolvedValue(true);
    vi.spyOn(WhatsappLinks, "whatsappLinkOf").mockResolvedValue(undefined);
    vi.spyOn(WhatsappLinks, "whatsappLinkById").mockResolvedValue(undefined);
    vi.spyOn(WhatsappLinks, "deleteWhatsappLink").mockResolvedValue({
      phone: "+15550000001",
    });
    vi.spyOn(Loopback, "postWhatsappLoopback").mockResolvedValue(
      new Response(null, { status: 204 })
    );
  });

  function linkOf(userId: string) {
    return {
      id: linkId,
      linkedAt: new Date(),
      phone: "+15550000001",
      userId,
    };
  }

  it("makes a link code for a member who may use WhatsApp, while the channel is open", async () => {
    await expect(whatsapp().linkCode()).resolves.toEqual({
      code: "ABCD2345",
      expiresAt: "2026-11-25T12:10:00.000Z",
    });
    expect(Allowlist.enrolledTeamMemberId).toHaveBeenCalledWith(
      "Member@Example.test"
    );
    expect(WhatsappLinks.createWhatsappLinkCode).toHaveBeenCalledWith("user-1");
  });

  it.each([
    [
      "the channel is closed",
      () => {
        vi.mocked(
          WhatsappEnvironment.whatsappChannelConfigured
        ).mockReturnValue(false);
      },
    ],
    [
      "the member can no longer sign in",
      () => {
        vi.mocked(Allowlist.enrolledTeamMemberId).mockResolvedValue(undefined);
      },
    ],
    [
      "the member has no user row",
      () => {
        vi.mocked(Allowlist.emailOfUser).mockResolvedValue(undefined);
      },
    ],
  ])("makes no link code when %s", async (_case, arrange) => {
    arrange();
    await expect(whatsapp().linkCode()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(WhatsappLinks.createWhatsappLinkCode).not.toHaveBeenCalled();
  });

  it("cancels the member's own code, and says whether it is live and which number landed", async () => {
    await whatsapp().cancelLinkCode();
    expect(WhatsappLinks.cancelWhatsappLinkCode).toHaveBeenCalledWith("user-1");

    await expect(whatsapp().linkStatus()).resolves.toEqual({
      codeLive: true,
      linkedId: null,
    });
    vi.mocked(WhatsappLinks.whatsappLinkOf).mockResolvedValue(linkOf("user-1"));
    vi.mocked(WhatsappLinks.whatsappLinkCodeLive).mockResolvedValue(false);
    await expect(whatsapp().linkStatus()).resolves.toEqual({
      codeLive: false,
      linkedId: linkId,
    });
    expect(WhatsappLinks.whatsappLinkOf).toHaveBeenCalledWith("user-1");
  });

  it("disconnects the member's own number and ends its chats on that number only", async () => {
    vi.mocked(WhatsappLinks.whatsappLinkById).mockResolvedValue(
      linkOf("user-1")
    );

    await whatsapp().disconnect({ id: linkId });

    expect(WhatsappLinks.deleteWhatsappLink).toHaveBeenCalledWith(
      linkId,
      "user-1"
    );
    expect(Loopback.postWhatsappLoopback).toHaveBeenCalledExactlyOnceWith(
      "/internal/whatsapp/end",
      { member: "better-auth:user-1", phone: "+15550000001" }
    );
    expect(Allowlist.isAdminMember).not.toHaveBeenCalled();
  });

  it("lets an administrator disconnect anyone's number, and reads anyone else's as none", async () => {
    vi.mocked(WhatsappLinks.whatsappLinkById).mockResolvedValue(
      linkOf("user-2")
    );

    await expect(whatsapp().disconnect({ id: linkId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(WhatsappLinks.deleteWhatsappLink).not.toHaveBeenCalled();
    expect(Loopback.postWhatsappLoopback).not.toHaveBeenCalled();

    vi.mocked(Allowlist.isAdminMember).mockResolvedValue(true);
    await whatsapp().disconnect({ id: linkId });
    expect(Allowlist.isAdminMember).toHaveBeenCalledWith("user-1");
    expect(WhatsappLinks.deleteWhatsappLink).toHaveBeenCalledWith(
      linkId,
      "user-2"
    );
    expect(Loopback.postWhatsappLoopback).toHaveBeenCalledWith(
      "/internal/whatsapp/end",
      { member: "better-auth:user-2", phone: "+15550000001" }
    );
  });

  it("refuses a link that is not there, or is gone by the time it is deleted", async () => {
    await expect(
      whatsapp().disconnect({ id: "not-a-link" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(whatsapp().disconnect({ id: linkId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    vi.mocked(WhatsappLinks.whatsappLinkById).mockResolvedValue(
      linkOf("user-1")
    );
    vi.mocked(WhatsappLinks.deleteWhatsappLink).mockResolvedValue(undefined);
    await expect(whatsapp().disconnect({ id: linkId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(Loopback.postWhatsappLoopback).not.toHaveBeenCalled();
  });
});

function vaultItem(kind: "address" | "login") {
  return {
    account: "",
    createdAt: "2026-11-23T00:00:00.000Z",
    id: `${kind}-1`,
    kind,
    label: "Vendor portal",
    site: null,
    updatedAt: "2026-11-23T00:00:00.000Z",
  };
}
