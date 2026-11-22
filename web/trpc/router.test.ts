import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as BrowserTraces from "@db/services/browser-traces";
import * as Chats from "@db/services/chats";
import type { AccessScope } from "@shared/identity/access-scope";
import { appRouter } from "./router";

const listBrowserTracesMock = vi.spyOn(BrowserTraces, "listBrowserTraces");
const saveChatMock = vi.spyOn(Chats, "saveChat");

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
});
