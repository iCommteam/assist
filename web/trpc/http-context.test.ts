import type { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@web/auth/request-scope";
import type { AccessScope } from "@shared/identity/access-scope";
import { createHTTPContext } from "./http-context";

describe("createHTTPContext", () => {
  it("blocks cross-origin mutations", async () => {
    const getScope = vi.fn<() => Promise<never>>();

    await expect(
      createHTTPContext(
        new Request("https://example.com/api/trpc", {
          headers: { Origin: "https://attacker.example" },
          method: "POST",
        }),
        getScope
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<TRPCError>>({
        code: "FORBIDDEN",
      })
    );
    expect(getScope).not.toHaveBeenCalled();
  });

  it.each([
    ["no Origin", {}],
    [
      "a forwarded host that matches the attacker",
      {
        Origin: "https://attacker.example",
        "X-Forwarded-Host": "attacker.example",
        "X-Forwarded-Proto": "https",
      },
    ],
    ["the right host over http", { Origin: "http://example.com" }],
  ])("blocks a mutation with %s", async (_label, headers) => {
    const getScope = vi.fn<() => Promise<never>>();

    await expect(
      createHTTPContext(
        new Request("https://attacker.example/api/trpc", {
          headers,
          method: "POST",
        }),
        getScope
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<TRPCError>>({ code: "FORBIDDEN" })
    );
    expect(getScope).not.toHaveBeenCalled();
  });

  it("accepts a mutation from the configured application origin", async () => {
    const scope = { userId: "user-1", workspaceId: "workspace-1" };
    const getScope = vi
      .fn<() => Promise<AccessScope>>()
      .mockResolvedValue(scope);

    await expect(
      createHTTPContext(
        new Request("http://10.0.0.5:3000/api/trpc", {
          headers: { Origin: "https://example.com" },
          method: "POST",
        }),
        getScope
      )
    ).resolves.toMatchObject({ scope });
  });

  it("maps a missing session to an unauthorized tRPC error", async () => {
    const getScope = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new UnauthenticatedError());

    await expect(
      createHTTPContext(new Request("https://example.com/api/trpc"), getScope)
    ).rejects.toEqual(
      expect.objectContaining<Partial<TRPCError>>({
        code: "UNAUTHORIZED",
      })
    );
  });

  it("preserves unexpected authentication infrastructure failures", async () => {
    const failure = new Error("database unavailable");
    const getScope = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(
      createHTTPContext(new Request("https://example.com/api/trpc"), getScope)
    ).rejects.toBe(failure);
  });
});
