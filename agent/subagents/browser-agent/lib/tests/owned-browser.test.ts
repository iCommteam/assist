import { beforeEach, describe, expect, it, vi } from "vitest";
import * as BrowserService from "@db/services/browsers";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";

const readBrowserSessionMock = vi.spyOn(BrowserService, "readBrowserSession");
const owner = accessScopeForUser("better-auth:owner-1");
const record = {
  createdAt: "2026-08-27T00:00:00.000Z",
  sessionId: "browser-1",
  workerSessionId: "worker-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  readBrowserSessionMock.mockResolvedValue(record);
});

describe("owned browser sessions", () => {
  it("returns a browser to the worker that created it", async () => {
    await expect(
      requireOwnedBrowserSession(owner, { id: "worker-1" }, "browser-1")
    ).resolves.toEqual(record);
    expect(readBrowserSessionMock).toHaveBeenCalledExactlyOnceWith(
      owner,
      "browser-1"
    );
  });

  it.each([
    ["another task's worker", record],
    ["a browser with no recorded worker", { ...record, workerSessionId: null }],
    ["a browser the workspace does not hold", undefined],
  ])("reads as missing for %s", async (_case, stored) => {
    readBrowserSessionMock.mockResolvedValue(stored);

    await expect(
      requireOwnedBrowserSession(owner, { id: "worker-2" }, "browser-1")
    ).rejects.toThrow("Browser session not found.");
  });
});
