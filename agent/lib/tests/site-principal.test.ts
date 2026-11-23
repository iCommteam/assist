import { describe, expect, it } from "vitest";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  siteLoginOfSession,
  siteOfSession,
  sitePrincipal,
} from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";

const owner = accessScopeForUser("better-auth:owner-1");
const login = { id: "login-1", origin: "https://login.vendor.example" };

describe("site principal", () => {
  it("carries a create grant's login pin into the session's initiator", () => {
    const principal = sitePrincipal(
      { login, op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );

    expect(principal).toEqual({
      attributes: {
        conversationChannel: "eve",
        email: "owner@example.test",
        site: "teemiq",
        siteLogin: "login-1",
        siteLoginOrigin: "https://login.vendor.example",
        workspaceId: owner.workspaceId,
      },
      authenticator: "assist-site",
      principalId: owner.userId,
      principalType: "user",
    });
    expect(siteOfSession(principal)).toBe("teemiq");
    expect(siteLoginOfSession(principal)).toEqual(login);
    expect(scopeFromPrincipal(principal)).toEqual(owner);
  });

  it("pins nothing for an unpinned create or a stream read", () => {
    const unpinned = sitePrincipal(
      { op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );
    const read = sitePrincipal(
      { op: "read", session: "wrun_1", site: "teemiq" },
      "owner@example.test",
      owner
    );

    expect(siteOfSession(unpinned)).toBe("teemiq");
    expect(siteLoginOfSession(unpinned)).toBeUndefined();
    expect(Object.keys(read.attributes)).not.toContain("siteLogin");
    expect(siteLoginOfSession(read)).toBeUndefined();
  });

  it("reads a pin only from a site initiator", () => {
    const pinned = sitePrincipal(
      { login, op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );

    expect(
      siteLoginOfSession({ ...pinned, authenticator: "authjs" })
    ).toBeUndefined();
    expect(siteLoginOfSession(null)).toBeUndefined();
    expect(
      siteLoginOfSession({
        ...pinned,
        attributes: { ...pinned.attributes, siteLoginOrigin: "not an origin" },
      })
    ).toBeUndefined();
  });
});
