import type * as KernelSdk from "@onkernel/sdk";
import { NotFoundError } from "@onkernel/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readBrowserSession } from "@db/services/browsers";
import type { requireRequestScope } from "@web/auth/request-scope";

const mocks = vi.hoisted(() => ({
  readBrowserSession: vi.fn<typeof readBrowserSession>(),
  requireRequestScope: vi.fn<typeof requireRequestScope>(),
  retrieve: vi.fn<
    (id: string) => Promise<{
      readonly browser_live_view_url?: string;
      readonly deleted_at?: string;
    }>
  >(),
}));

vi.mock("@onkernel/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof KernelSdk>()),
  default: class {
    browsers = { retrieve: mocks.retrieve };
  },
}));
vi.mock("@db/services/browsers", () => ({
  readBrowserSession: mocks.readBrowserSession,
}));
// The real module reads the Better Auth session; only its contract is needed.
vi.mock("@web/auth/request-scope", () => ({
  requireRequestScope: mocks.requireRequestScope,
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}));

import { UnauthenticatedError } from "@web/auth/request-scope";
import { GET } from "../route";

const scope = { userId: "user-1", workspaceId: "workspace-1" };

function open(id: string) {
  return GET(new Request(`https://example.com/browsers/${id}/live`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRequestScope.mockResolvedValue(scope);
  mocks.readBrowserSession.mockResolvedValue({
    createdAt: "2026-11-22T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-1",
  });
  mocks.retrieve.mockResolvedValue({
    browser_live_view_url: "https://live.kernel.test/browser-1?token=abc",
  });
});

describe("browser handoff route", () => {
  it("redirects the owner to a fresh live view with no caching or referrer", async () => {
    const response = await open("browser-1");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://live.kernel.test/browser-1?token=abc"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.readBrowserSession).toHaveBeenCalledExactlyOnceWith(
      scope,
      "browser-1"
    );
    expect(mocks.retrieve).toHaveBeenCalledOnce();
  });

  it("never asks Kernel about a browser outside the member's workspace", async () => {
    mocks.readBrowserSession.mockResolvedValue(undefined);

    const response = await open("browser-other");

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("refuses a request without a completed sign-in", async () => {
    mocks.requireRequestScope.mockRejectedValue(new UnauthenticatedError());

    const response = await open("browser-1");

    expect(response.status).toBe(401);
    expect(mocks.readBrowserSession).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("reports a deleted or missing browser as unavailable", async () => {
    mocks.retrieve.mockResolvedValueOnce({
      browser_live_view_url: "https://live.kernel.test/old",
      deleted_at: "2026-11-22T01:00:00.000Z",
    });
    expect((await open("browser-1")).status).toBe(404);

    mocks.retrieve.mockRejectedValueOnce(
      new NotFoundError(404, undefined, "not found", new Headers())
    );
    const response = await open("browser-1");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
