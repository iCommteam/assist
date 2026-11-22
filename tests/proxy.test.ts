import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getAuthSession } from "@db/services/auth/session";
import { authSessionFor } from "@tests/helpers/auth-session";
import { proxy } from "../proxy";

const auth = vi.hoisted(() => ({ getSession: vi.fn<typeof getAuthSession>() }));
vi.mock("@db/services/auth/session", () => ({
  getAuthSession: auth.getSession,
}));

describe("sign-in proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getSession.mockResolvedValue(null);
  });

  it.each(["/sign-in", "/sign-up", "/two-factor", "/api/auth/x"])(
    "serves %s without a completed sign-in",
    async (path) => {
      const response = await proxy(
        new NextRequest(`https://example.com${path}`)
      );
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(auth.getSession).not.toHaveBeenCalled();
    }
  );

  it.each([
    "/",
    "/vault",
    "/sign-up/other",
    "/two-factor/other",
    "/contacts/openinstinct.vcf",
  ])("redirects %s to sign-in without a completed sign-in", async (path) => {
    const response = await proxy(new NextRequest(`https://example.com${path}`));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `https://example.com/sign-in?callbackUrl=${encodeURIComponent(path)}`
    );
  });

  it.each([
    "/api/site/ping",
    "/api/site/tasks",
    "/api/site/tasks/00000000-0000-4000-8000-000000000001",
  ])(
    "lets the site API at %s authenticate its own bearer token",
    async (path) => {
      const response = await proxy(
        new NextRequest(`https://example.com${path}`, {
          headers: { authorization: "Bearer token" },
          method: path === "/api/site/tasks" ? "POST" : "GET",
        })
      );
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(auth.getSession).not.toHaveBeenCalled();
    }
  );

  it.each([
    "/api/site",
    "/api/site/",
    "/api/site/other",
    "/api/site/tasks/",
    "/api/site/tasks/one/two",
    "/api/site/pingx",
    "/api/trpc/vault.list",
  ])("keeps the sign-in redirect for %s", async (path) => {
    const response = await proxy(new NextRequest(`https://example.com${path}`));
    expect(response.status).toBe(307);
  });

  it("serves application routes to a completed sign-in", async () => {
    auth.getSession.mockResolvedValue(
      authSessionFor({ id: "user-1", twoFactorEnabled: true })
    );
    const response = await proxy(new NextRequest("https://example.com/vault"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

function write(
  path: string,
  headers: Readonly<Record<string, string>>,
  method = "POST"
) {
  return proxy(
    new NextRequest(`https://example.com${path}`, { headers, method })
  );
}

describe("cross-site request forgery guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getSession.mockResolvedValue(
      authSessionFor({ id: "user-1", twoFactorEnabled: true })
    );
  });

  it.each(["/eve/v1/session", "/api/trpc/vault.remove", "/vault"])(
    "refuses a cookie write to %s from another origin",
    async (path) => {
      const responses = await Promise.all(
        [
          "https://evil.example.com",
          "https://sub.example.com",
          "http://example.com",
          "null",
        ].map((origin) => write(path, { origin }))
      );
      expect(responses.map((response) => response.status)).toEqual([
        403, 403, 403, 403,
      ]);
      expect(await responses[0]?.json()).toEqual({ error: "forbidden" });
      expect(auth.getSession).not.toHaveBeenCalled();
    }
  );

  it("refuses a write without an Origin, and ignores forwarded hosts", async () => {
    expect((await write("/eve/v1/session", {})).status).toBe(403);
    expect(
      (
        await write("/eve/v1/session", {
          origin: "https://evil.example.com",
          "x-forwarded-host": "evil.example.com",
          "x-forwarded-proto": "https",
        })
      ).status
    ).toBe(403);
    const writes = await Promise.all(
      ["PUT", "PATCH", "DELETE"].map((method) =>
        write("/eve/v1/session", { origin: "https://evil.test" }, method)
      )
    );
    expect(writes.map((response) => response.status)).toEqual([403, 403, 403]);
  });

  it("passes a same-origin write and every read", async () => {
    const same = await write("/eve/v1/session", {
      origin: "https://example.com",
    });
    expect(same.headers.get("x-middleware-next")).toBe("1");

    const read = await proxy(
      new NextRequest("https://example.com/vault", {
        headers: { origin: "https://evil.example.com" },
      })
    );
    expect(read.headers.get("x-middleware-next")).toBe("1");
  });

  it("leaves Better Auth and the bearer site API to their own checks", async () => {
    auth.getSession.mockResolvedValue(null);
    const signIn = await write("/api/auth/sign-in/email", {
      origin: "https://evil.example.com",
    });
    expect(signIn.headers.get("x-middleware-next")).toBe("1");

    const site = await write("/api/site/tasks", {
      authorization: "Bearer token",
    });
    expect(site.headers.get("x-middleware-next")).toBe("1");
  });
});
