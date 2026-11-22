import type { RouteHandlerArgs } from "eve/channels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as AuthSession from "@db/services/auth/session";
import * as SessionService from "@db/services/sessions";
import * as SiteService from "@db/services/sites";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  mintSiteCredential,
  type SiteGrant,
} from "@shared/identity/site-credential";
import { authSessionFor } from "@tests/helpers/auth-session";
import eveChannel from "@agent/channels/eve";

const secret = "test-auth-secret-0123456789abcdefghijklmnop";
const owner = accessScopeForUser("better-auth:owner-1");

const getAuthSessionMock = vi.spyOn(AuthSession, "getAuthSession");
const isSessionOwnedMock = vi.spyOn(SessionService, "isSessionOwned");
const resolveSiteOwnerMock = vi.spyOn(SiteService, "resolveSiteOwner");
const isSiteTaskSessionMock = vi.spyOn(SiteService, "isSiteTaskSession");

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-22T12:00:00.000Z") });
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  getAuthSessionMock.mockResolvedValue(
    authSessionFor({ email: "member@example.test", id: "member-1" })
  );
  resolveSiteOwnerMock.mockResolvedValue({
    email: "owner@example.test",
    ok: true,
    scope: owner,
  });
  isSiteTaskSessionMock.mockResolvedValue(true);
  isSessionOwnedMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

const readOwn: SiteGrant = { op: "read", session: "wrun_own", site: "teemiq" };

describe("Eve channel site credential", () => {
  it("decides a request that presents one, never falling through to the cookie", async () => {
    const response = await stream(
      "wrun_own",
      mintSiteCredential(`${secret}-forged`, readOwn)
    );

    expect(response.status).toBe(401);
    expect(getAuthSessionMock).not.toHaveBeenCalled();
    expect(resolveSiteOwnerMock).not.toHaveBeenCalled();
  });

  it("refuses an expired credential", async () => {
    const credential = mintSiteCredential(secret, readOwn);
    vi.advanceTimersByTime(61_000);

    expect((await stream("wrun_own", credential)).status).toBe(401);
  });

  it.each([
    ["a create grant", { op: "create", site: "teemiq" }, "wrun_own"],
    ["a read grant for another session", readOwn, "wrun_victim"],
  ] satisfies [string, SiteGrant, string][])(
    "refuses %s on a session stream",
    async (_case, grant, sessionId) => {
      const response = await stream(
        sessionId,
        mintSiteCredential(secret, grant)
      );

      expect(response.status).toBe(403);
      expect(isSessionOwnedMock).not.toHaveBeenCalled();
    }
  );

  it("refuses a read grant on a session the site did not create", async () => {
    isSiteTaskSessionMock.mockResolvedValue(false);

    const response = await stream(
      "wrun_own",
      mintSiteCredential(secret, readOwn)
    );

    expect(response.status).toBe(403);
    expect(isSiteTaskSessionMock).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      "wrun_own"
    );
    expect(isSessionOwnedMock).not.toHaveBeenCalled();
  });

  it("refuses every call while the owner cannot sign in", async () => {
    resolveSiteOwnerMock.mockResolvedValue({
      ok: false,
      reason: "owner has no authenticator",
    });

    const response = await stream(
      "wrun_own",
      mintSiteCredential(secret, readOwn)
    );

    expect(response.status).toBe(403);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "[site] eve call refused",
      { reason: "owner has no authenticator", site: "teemiq" }
    );
  });

  it("refuses a site credential on callback routes", async () => {
    const route = findRoute("POST", "/eve/v1/callback/:token");
    const response = await route.handler(
      new Request(
        "https://assistant.example/eve/v1/callback/eve%3Asession%3Awrun_own%3Ainbox",
        {
          body: "{}",
          headers: {
            authorization: `Bearer ${mintSiteCredential(secret, readOwn)}`,
          },
          method: "POST",
        }
      ),
      unexpectedRouteContext()
    );

    expect(response.status).toBe(403);
  });

  it("admits a read of the site's own session as its owner", async () => {
    const pending = stream("wrun_own", mintSiteCredential(secret, readOwn));

    // Past authorization the route reaches eve's runtime, which this test
    // does not provide.
    await expect(pending).rejects.toThrow(
      "The request should stop at authorization."
    );
    expect(isSessionOwnedMock).toHaveBeenCalledExactlyOnceWith(
      owner,
      "wrun_own"
    );
    expect(getAuthSessionMock).not.toHaveBeenCalled();
  });
});

async function stream(sessionId: string, credential: string) {
  const route = findRoute("GET", "/eve/v1/session/:sessionId/stream");
  return route.handler(
    new Request(
      `https://assistant.example/eve/v1/session/${sessionId}/stream?follow=false`,
      { headers: { authorization: `Bearer ${credential}` } }
    ),
    { ...unexpectedRouteContext(), params: { sessionId } }
  );
}

function findRoute(method: string, path: string) {
  const route = eveChannel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === method &&
      candidate.path === path
  );
  if (!route || route.transport === "websocket") {
    throw new Error(`The Eve route ${method} ${path} is unavailable.`);
  }
  return route;
}

function unexpectedRouteContext() {
  return {
    attachSession: unexpectedRouteRequest,
    describe: unexpectedRouteRequest,
    from: unexpectedRouteRequest,
    invokeTool: unexpectedRouteRequest,
    listSkillFiles: unexpectedRouteRequest,
    params: {},
    readSkill: unexpectedRouteRequest,
    requestIp: null,
    resolveSession: unexpectedRouteRequest,
    to: unexpectedRouteRequest,
    waitUntil: unexpectedRouteRequest,
  } satisfies RouteHandlerArgs;
}

function unexpectedRouteRequest(): never {
  throw new Error("The request should stop at authorization.");
}
