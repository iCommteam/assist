/* oxlint-disable typescript/no-unsafe-type-assertion -- Kernel's page type has private members beyond the AsyncIterable contract consumed by the browser tool. */
import { NotFoundError } from "@onkernel/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  createBrowserSession,
  deleteBrowserSession,
  listWorkerBrowserSessions,
  withBrowserProfileWriteLock,
} from "@db/services/browsers";
import type { recordBrowserTraceDomains } from "@db/services/browser-traces";
import type { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import type { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import type * as TraceDomainsModule from "@agent/subagents/browser-agent/lib/trace/domains";
import type { harvestBrowserTraceDomains } from "@agent/subagents/browser-agent/lib/trace/domains";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import { toolContextFor } from "@tests/helpers/tool-context";
import { resetEveState } from "@tests/helpers/eve-state";
import manageBrowsers from "@agent/subagents/browser-agent/tools/manage_browsers";
import { amazonUrlBlocklist } from "@agent/subagents/browser-agent/lib/policy/hosts";
import { checkBrowserPages } from "@agent/subagents/browser-agent/lib/policy/page-check";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  kernelProfileNameForLogin,
  kernelProfileNameForWorkspace,
} from "@shared/browser/kernel-profile";

const serviceMocks = vi.hoisted(() => ({
  createBrowserSession: vi.fn<typeof createBrowserSession>(),
  deleteBrowserSession: vi.fn<typeof deleteBrowserSession>(),
  harvestBrowserTraceDomains: vi.fn<typeof harvestBrowserTraceDomains>(),
  listWorkerBrowserSessions: vi.fn<typeof listWorkerBrowserSessions>(),
  recordBrowserTraceDomains: vi.fn<typeof recordBrowserTraceDomains>(),
  requireOwnedBrowserSession: vi.fn<typeof requireOwnedBrowserSession>(),
  requireWorkerScope: vi.fn<typeof requireWorkerScope>(),
  withBrowserProfileWriteLock: vi.fn<typeof withBrowserProfileWriteLock>(),
}));

vi.mock("@db/services/browsers", () => ({
  createBrowserSession: serviceMocks.createBrowserSession,
  deleteBrowserSession: serviceMocks.deleteBrowserSession,
  listWorkerBrowserSessions: serviceMocks.listWorkerBrowserSessions,
  withBrowserProfileWriteLock: serviceMocks.withBrowserProfileWriteLock,
}));
vi.mock("@db/services/browser-traces", () => ({
  recordBrowserTraceDomains: serviceMocks.recordBrowserTraceDomains,
}));
vi.mock("@agent/subagents/browser-agent/lib/access", () => ({
  requireWorkerScope: serviceMocks.requireWorkerScope,
}));
vi.mock("@agent/subagents/browser-agent/lib/owned-browser", () => ({
  requireOwnedBrowserSession: serviceMocks.requireOwnedBrowserSession,
}));
vi.mock(
  "@agent/subagents/browser-agent/lib/trace/domains",
  async (importOriginal) => ({
    ...(await importOriginal<typeof TraceDomainsModule>()),
    harvestBrowserTraceDomains: serviceMocks.harvestBrowserTraceDomains,
  })
);

vi.mock("eve/context", () => import("@tests/helpers/eve-state"));

const mocks = {
  createBrowser: vi.spyOn(kernel.browsers, "create"),
  createBrowserSession: serviceMocks.createBrowserSession,
  deleteBrowser: vi.spyOn(kernel.browsers, "deleteByID"),
  deleteBrowserSession: serviceMocks.deleteBrowserSession,
  harvestBrowserTraceDomains: serviceMocks.harvestBrowserTraceDomains,
  listWorkerBrowserSessions: serviceMocks.listWorkerBrowserSessions,
  listKernelBrowsers: vi.spyOn(kernel.browsers, "list"),
  playwright: vi.spyOn(kernel.browsers.playwright, "execute"),
  readBrowserSession: serviceMocks.requireOwnedBrowserSession,
  recordBrowserTraceDomains: serviceMocks.recordBrowserTraceDomains,
  retrieveBrowser: vi.spyOn(kernel.browsers, "retrieve"),
  retrieveProfile: vi.spyOn(kernel.profiles, "retrieve"),
  requireWorkerScope: serviceMocks.requireWorkerScope,
  withBrowserProfileWriteLock: serviceMocks.withBrowserProfileWriteLock,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetEveState();
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.retrieveProfile.mockResolvedValue({
    created_at: "2026-08-27T00:00:00.000Z",
    id: "profile-1",
    name: "opaque-profile",
  });
  mocks.listKernelBrowsers.mockReturnValue(kernelBrowserPage([]));
  mocks.createBrowser.mockResolvedValue({
    browser_live_view_url: "https://live.kernel.test/browser-1",
    cdp_ws_url: "wss://kernel.test/cdp",
    created_at: "2026-08-27T00:00:00.000Z",
    headless: false,
    memory: "2GiB",
    profile: {
      created_at: "2026-08-27T00:00:00.000Z",
      id: "profile-1",
    },
    profile_save_changes: false,
    region: "us-east",
    session_id: "browser-1",
    stealth: false,
    timeout_seconds: 900,
    webdriver_ws_url: "wss://kernel.test/webdriver",
  });
  mocks.deleteBrowser.mockResolvedValue();
  mocks.createBrowserSession.mockResolvedValue();
  mocks.deleteBrowserSession.mockResolvedValue(true);
  mocks.harvestBrowserTraceDomains.mockResolvedValue();
  mocks.listWorkerBrowserSessions.mockResolvedValue([]);
  mocks.readBrowserSession.mockResolvedValue({
    createdAt: "2026-08-27T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-session-1",
  });
  mocks.recordBrowserTraceDomains.mockResolvedValue();
  mocks.withBrowserProfileWriteLock.mockImplementation(
    async (_scope, operation) => operation()
  );
});

const workerContext = toolContextFor({ sessionId: "worker-session-1" });

describe("Kernel browser contract", () => {
  it("keeps agent-created browsers alive between 15 minutes and an hour", () => {
    const inputSchema = manageBrowsers.inputSchema;
    if (!(inputSchema instanceof z.ZodType)) {
      throw new Error("manage_browsers must use a Zod input schema.");
    }

    expect(
      inputSchema.safeParse({
        action: "create",
        timeout_seconds: 120,
      }).success
    ).toBe(false);
    expect(
      inputSchema.safeParse({
        action: "create",
        timeout_seconds: 900,
      }).success
    ).toBe(true);
    expect(
      inputSchema.safeParse({ action: "create", timeout_seconds: 3_600 })
        .success
    ).toBe(true);
    expect(
      inputSchema.safeParse({ action: "create", timeout_seconds: 3_601 })
        .success
    ).toBe(false);
  });

  it("starts a read-only persistent-profile browser at the target URL", async () => {
    const result = await manageBrowsers.execute(
      { action: "create", start_url: "https://example.com/checkout" },
      workerContext
    );

    expect(result).toMatchObject({
      browser: {
        handoff_url: "https://example.com/browsers/browser-1/live",
        session_id: "browser-1",
      },
    });
    // Kernel's live-view URL controls the browser; it never reaches the model.
    expect(JSON.stringify(result)).not.toContain("live.kernel.test");
    expect(JSON.stringify(result)).not.toContain("browser_live_view_url");
    const lifecycle = z
      .object({ next_actions: z.array(z.string()) })
      .parse(result);
    expect(lifecycle.next_actions.join(" ")).toContain("browser_snapshot");
    expect(lifecycle.next_actions.join(" ")).toContain("browser_act");
    expect(lifecycle.next_actions.join(" ")).toContain("browser_navigate");
    expect(JSON.stringify(result)).not.toMatch(/playwright/iu);
    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      {
        chrome_policy: { URLBlocklist: amazonUrlBlocklist },
        kiosk_mode: true,
        profile: { id: "profile-1", save_changes: false },
        start_url: "https://example.com/checkout",
        stealth: false,
        telemetry: { browser: { page: { enabled: true } }, enabled: true },
        timeout_seconds: 900,
        viewport: undefined,
      },
      { maxRetries: 0, signal: workerContext.abortSignal }
    );
    // No proxy: without stealth, egress is direct and no solver runs.
    expect(mocks.createBrowser.mock.calls[0]?.[0]).not.toHaveProperty("proxy");
    expect(mocks.createBrowserSession).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        createdAt: "2026-08-27T00:00:00.000Z",
        sessionId: "browser-1",
        workerSessionId: "worker-session-1",
      }
    );
    expect(mocks.recordBrowserTraceDomains).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "worker-session-1",
      ["example.com"]
    );
    expect(mocks.withBrowserProfileWriteLock).not.toHaveBeenCalled();
  });

  it("refuses an Amazon start URL before creating any browser", async () => {
    await expect(
      manageBrowsers.execute(
        { action: "create", start_url: "https://sellercentral.amazon.com/" },
        workerContext
      )
    ).rejects.toThrow(/blocked by policy for now/u);
    await expect(
      manageBrowsers.execute(
        { action: "create", start_url: "https://www.amazon.co.uk/" },
        workerContext
      )
    ).rejects.toThrow(/blocked by policy/u);
    expect(mocks.retrieveProfile).not.toHaveBeenCalled();
    expect(mocks.createBrowser).not.toHaveBeenCalled();
  });

  it("fences a pinned site task's browser to its login's site", async () => {
    const context = siteWorkerContext({
      id: "login-1",
      origin: "https://login.vendor.com",
    });

    await manageBrowsers.execute(
      { action: "create", start_url: "https://billing.vendor.com/invoices" },
      context
    );

    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        chrome_policy: {
          URLAllowlist: ["vendor.com"],
          URLBlocklist: ["*", ...amazonUrlBlocklist],
        },
        start_url: "https://billing.vendor.com/invoices",
      }),
      expect.anything()
    );
  });

  it("refuses a pinned site task's start URL outside its site before any browser", async () => {
    const context = siteWorkerContext({
      id: "login-1",
      origin: "https://login.vendor.com",
    });

    await expect(
      manageBrowsers.execute(
        { action: "create", start_url: "https://attacker.example/?d=x" },
        context
      )
    ).rejects.toThrow(/attacker\.example is outside vendor\.com/u);
    await expect(
      manageBrowsers.execute(
        { action: "create", start_url: "https://www.amazon.com/" },
        context
      )
    ).rejects.toThrow(/blocked by policy for now/u);
    expect(mocks.retrieveProfile).not.toHaveBeenCalled();
    expect(mocks.createBrowser).not.toHaveBeenCalled();
  });

  it("keeps the Amazon blocklist alone for an unpinned site task", async () => {
    await manageBrowsers.execute(
      { action: "create", start_url: "https://example.com/" },
      siteWorkerContext(undefined)
    );

    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        chrome_policy: { URLBlocklist: amazonUrlBlocklist },
      }),
      expect.anything()
    );
  });

  it("creates no browser after a block but still deletes one", async () => {
    mocks.playwright.mockResolvedValueOnce({
      result: [
        {
          frames: [],
          status: 429,
          text: "",
          timeOrigin: 1,
          title: "Too many requests",
          url: "https://shop.example.com/",
        },
      ],
      success: true,
    });
    expect((await checkBrowserPages("browser-1")).status).toBe("blocked");

    await expect(
      manageBrowsers.execute({ action: "create" }, workerContext)
    ).rejects.toThrow(/already stopped at a block/u);
    expect(mocks.createBrowser).not.toHaveBeenCalled();
    await expect(
      manageBrowsers.execute(
        { action: "delete", session_id: "browser-1" },
        workerContext
      )
    ).resolves.toBe("Browser session deleted successfully");
    expect(mocks.deleteBrowser).toHaveBeenCalledOnce();
  });

  it("harvests visited domains from Kernel telemetry before deleting a browser", async () => {
    mocks.readBrowserSession.mockResolvedValue({
      createdAt: "2026-08-27T00:00:00.000Z",
      sessionId: "browser-1",
      workerSessionId: "worker-session-1",
    });

    const result = await manageBrowsers.execute(
      { action: "delete", session_id: "browser-1" },
      workerContext
    );

    expect(result).toBe("Browser session deleted successfully");
    expect(mocks.harvestBrowserTraceDomains).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "worker-session-1",
      { createdAt: "2026-08-27T00:00:00.000Z", sessionId: "browser-1" },
      expect.any(AbortSignal)
    );
    expect(
      mocks.harvestBrowserTraceDomains.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.deleteBrowser.mock.invocationCallOrder[0] ?? 0);
  });

  it("allows only one writable profile browser", async () => {
    mocks.listKernelBrowsers.mockReturnValue(
      kernelBrowserPage([
        {
          profile: { id: "profile-1" },
          profile_save_changes: true,
          session_id: "browser-active",
        },
      ])
    );
    await expect(
      manageBrowsers.execute(
        { action: "create", save_changes: true },
        toolContextFor()
      )
    ).rejects.toThrow(/browser-active.*saving login state/i);
    expect(mocks.withBrowserProfileWriteLock).toHaveBeenCalledOnce();
    expect(mocks.createBrowser).not.toHaveBeenCalled();
  });

  it("prunes stale owned records when Kernel reports a missing browser", async () => {
    mocks.listWorkerBrowserSessions.mockResolvedValue([
      {
        createdAt: "2026-08-27T00:00:00.000Z",
        sessionId: "stale-browser",
      },
    ]);
    mocks.retrieveBrowser.mockRejectedValue({ status: 404 });

    const result = await manageBrowsers.execute(
      { action: "list" },
      toolContextFor()
    );

    expect(result).toEqual({ has_more: false, items: [], next_offset: null });
    expect(mocks.deleteBrowserSession).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "stale-browser"
    );
  });

  it("lists and opens only the browsers this worker created", async () => {
    mocks.listWorkerBrowserSessions.mockResolvedValue([
      { createdAt: "2026-08-27T00:00:00.000Z", sessionId: "browser-1" },
    ]);
    mocks.retrieveBrowser.mockResolvedValue({
      cdp_ws_url: "wss://kernel.test/cdp",
      created_at: "2026-08-27T00:00:00.000Z",
      headless: false,
      memory: "2GiB",
      region: "us-east",
      session_id: "browser-1",
      stealth: false,
      timeout_seconds: 900,
      webdriver_ws_url: "wss://kernel.test/webdriver",
    });

    const listed = await manageBrowsers.execute(
      { action: "list" },
      workerContext
    );
    await manageBrowsers.execute(
      { action: "get", session_id: "browser-1" },
      workerContext
    );

    expect(listed).toMatchObject({ items: [{ session_id: "browser-1" }] });
    expect(mocks.listWorkerBrowserSessions).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "worker-session-1"
    );
    expect(mocks.readBrowserSession).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      expect.objectContaining({ id: "worker-session-1" }),
      "browser-1"
    );
  });

  it("keeps a site task's browsers alive for 30 minutes, whatever the model asks", async () => {
    await manageBrowsers.execute(
      { action: "create", timeout_seconds: 900 },
      siteWorkerContext(undefined)
    );
    await manageBrowsers.execute(
      {
        action: "create",
        start_url: "https://vendor.com/",
        timeout_seconds: 3_600,
      },
      siteWorkerContext({ id: "login-1", origin: "https://vendor.com" })
    );
    await manageBrowsers.execute(
      { action: "create", timeout_seconds: 3_600 },
      workerContext
    );

    // Outlives fill_code_from_site's 20-minute wait for a relayed code.
    expect(
      mocks.createBrowser.mock.calls.map(([params]) => params?.timeout_seconds)
    ).toEqual([1_800, 1_800, 3_600]);
  });

  it("keeps interactive browsers on the workspace profile", async () => {
    await manageBrowsers.execute(
      { action: "create", save_changes: true },
      workerContext
    );

    const workspaceProfile = kernelProfileNameForWorkspace("workspace-1");
    expect(mocks.retrieveProfile).toHaveBeenCalledExactlyOnceWith(
      workspaceProfile,
      expect.anything()
    );
    expect(mocks.withBrowserProfileWriteLock).toHaveBeenCalledExactlyOnceWith(
      workspaceProfile,
      expect.any(Function)
    );
    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        profile: { id: "profile-1", save_changes: true },
      }),
      expect.anything()
    );
  });

  it("gives an unpinned site task's browsers no profile at all", async () => {
    await manageBrowsers.execute(
      { action: "create", start_url: "https://example.com/" },
      siteWorkerContext(undefined)
    );

    expect(mocks.retrieveProfile).not.toHaveBeenCalled();
    expect(mocks.listKernelBrowsers).not.toHaveBeenCalled();
    expect(mocks.withBrowserProfileWriteLock).not.toHaveBeenCalled();
    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ profile: undefined }),
      expect.anything()
    );
  });

  it("refuses to save sign-in state for an unpinned site task", async () => {
    await expect(
      manageBrowsers.execute(
        { action: "create", save_changes: true },
        siteWorkerContext(undefined)
      )
    ).rejects.toThrow(
      'This site task is not pinned to a saved login, so its browsers keep no sign-in and cannot be created with save_changes. If the work needs a sign-in, return status "failure" saying the task has no saved login.'
    );

    expect(mocks.retrieveProfile).not.toHaveBeenCalled();
    expect(mocks.withBrowserProfileWriteLock).not.toHaveBeenCalled();
    expect(mocks.createBrowser).not.toHaveBeenCalled();
  });

  it("gives a pinned site task's browsers its login's own profile and writer lock", async () => {
    mocks.retrieveProfile.mockResolvedValue({
      created_at: "2026-08-27T00:00:00.000Z",
      id: "profile-login-1",
      name: "opaque-login-profile",
    });

    await manageBrowsers.execute(
      {
        action: "create",
        save_changes: true,
        start_url: "https://vendor.com/",
      },
      siteWorkerContext({ id: "login-1", origin: "https://vendor.com" })
    );

    const loginProfile = kernelProfileNameForLogin("workspace-1", "login-1");
    expect(mocks.retrieveProfile).toHaveBeenCalledExactlyOnceWith(
      loginProfile,
      expect.anything()
    );
    expect(mocks.withBrowserProfileWriteLock).toHaveBeenCalledExactlyOnceWith(
      loginProfile,
      expect.any(Function)
    );
    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        profile: { id: "profile-login-1", save_changes: true },
      }),
      expect.anything()
    );
  });

  it("creates a pinned login's profile the first time it is needed", async () => {
    mocks.retrieveProfile.mockRejectedValueOnce(
      new NotFoundError(404, undefined, "not found", new Headers())
    );
    const createProfile = vi
      .spyOn(kernel.profiles, "create")
      .mockResolvedValueOnce({
        created_at: "2026-08-27T00:00:00.000Z",
        id: "profile-login-1",
        name: "opaque-login-profile",
      });

    await manageBrowsers.execute(
      { action: "create", start_url: "https://vendor.com/" },
      siteWorkerContext({ id: "login-1", origin: "https://vendor.com" })
    );

    expect(createProfile).toHaveBeenCalledExactlyOnceWith(
      { name: kernelProfileNameForLogin("workspace-1", "login-1") },
      expect.anything()
    );
    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        profile: { id: "profile-login-1", save_changes: false },
      }),
      expect.anything()
    );
  });

  it("lets one login sign in while another login's profile has a writer", async () => {
    mocks.retrieveProfile
      .mockResolvedValueOnce({
        created_at: "2026-08-27T00:00:00.000Z",
        id: "profile-login-a",
        name: "opaque-login-a",
      })
      .mockResolvedValueOnce({
        created_at: "2026-08-27T00:00:00.000Z",
        id: "profile-login-b",
        name: "opaque-login-b",
      });
    mocks.listKernelBrowsers.mockReturnValue(
      kernelBrowserPage([
        {
          profile: { id: "profile-login-a" },
          profile_save_changes: true,
          session_id: "browser-login-a",
        },
      ])
    );

    await expect(
      manageBrowsers.execute(
        { action: "create", save_changes: true },
        siteWorkerContext({ id: "login-a", origin: "https://vendor.com" })
      )
    ).rejects.toThrow(/browser-login-a.*saving login state/iu);
    await manageBrowsers.execute(
      { action: "create", save_changes: true },
      siteWorkerContext({ id: "login-b", origin: "https://vendor.com" })
    );

    expect(mocks.retrieveProfile.mock.calls.map(([name]) => name)).toEqual([
      kernelProfileNameForLogin("workspace-1", "login-a"),
      kernelProfileNameForLogin("workspace-1", "login-b"),
    ]);
    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        profile: { id: "profile-login-b", save_changes: true },
      }),
      expect.anything()
    );
  });
});

// A worker of a site task, which inherits the root session's initiator.
function siteWorkerContext(login: { id: string; origin: string } | undefined) {
  const owner = accessScopeForUser("better-auth:owner-1");
  const initiator = sitePrincipal(
    { login, op: "create", site: "teemiq" },
    "owner@example.test",
    owner
  );
  return toolContextFor({
    auth: { current: initiator, initiator },
    sessionId: "worker-session-1",
  });
}

function asyncItems<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

function kernelBrowserPage(items: readonly unknown[]) {
  // SAFETY: manage_browsers consumes only the SDK page's AsyncIterable contract.
  return asyncItems(items) as ReturnType<typeof kernel.browsers.list>;
}
