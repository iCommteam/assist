import { describe, expect, it } from "vitest";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { accessScopeForUser } from "@shared/identity/access-scope";

describe("principal scope", () => {
  it("accepts the workspace derived from the authenticated user", () => {
    const scope = accessScopeForUser("better-auth:user-1");
    expect(
      scopeFromPrincipal({
        attributes: { workspaceId: scope.workspaceId },
        authenticator: "authjs",
        principalId: scope.userId,
        principalType: "user",
      })
    ).toEqual(scope);
  });

  it("accepts a connected site acting for its owner", () => {
    const owner = accessScopeForUser("better-auth:owner-1");
    expect(
      scopeFromPrincipal({
        attributes: { site: "teemiq", workspaceId: owner.workspaceId },
        authenticator: "assist-site",
        principalId: owner.userId,
        principalType: "user",
      })
    ).toEqual(owner);
  });

  it("rejects a workspace attribute that belongs to another user", () => {
    const victim = accessScopeForUser("better-auth:victim");
    expect(() =>
      scopeFromPrincipal({
        attributes: { workspaceId: victim.workspaceId },
        authenticator: "authjs",
        principalId: "better-auth:attacker",
        principalType: "user",
      })
    ).toThrow("does not belong to the authenticated user");
  });

  it.each([
    "local-dev",
    "linq:+15550100",
    "site:teemiq",
    "better-auth:",
    "better-auth:   ",
    " better-auth:user-1",
  ])(
    "rejects the principal %j, which this app never issues, whatever workspace it claims",
    (principalId) => {
      const claimed = accessScopeForUser(principalId.trim() || "x");
      expect(() =>
        scopeFromPrincipal({
          attributes: { workspaceId: claimed.workspaceId },
          authenticator: "local-dev",
          principalId,
          principalType: "user",
        })
      ).toThrow("An authenticated workspace user is required.");
    }
  );

  it("rejects a connection principal outside Better Auth", () => {
    expect(() =>
      scopeFromPrincipal({
        attributes: { workspaceId: "personal:victim" },
        id: "oidc:issuer:user",
        type: "user",
      })
    ).toThrow("An authenticated workspace user is required.");
  });
});
