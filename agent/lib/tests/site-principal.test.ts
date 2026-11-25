import { describe, expect, it } from "vitest";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  siteChatOfSession,
  siteKindOfSession,
  siteLoginOfSession,
  siteOfSession,
  sitePrincipal,
  siteTaskKindOfSession,
  siteTaskNoteOfSession,
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
    expect(siteLoginOfSession(principal)).toEqual({ ...login, alsoHosts: [] });
    expect(scopeFromPrincipal(principal)).toEqual(owner);
  });

  it("carries the hosts the login's site also uses, when it has any", () => {
    const principal = sitePrincipal(
      {
        login: { ...login, alsoHosts: ["chatgpt.com"] },
        op: "create",
        site: "teemiq",
      },
      "owner@example.test",
      owner
    );
    const none = sitePrincipal(
      { login: { ...login, alsoHosts: [] }, op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );

    expect(principal.attributes).toMatchObject({
      siteLogin: "login-1",
      siteLoginAlsoHosts: ["chatgpt.com"],
    });
    expect(siteLoginOfSession(principal)).toEqual({
      ...login,
      alsoHosts: ["chatgpt.com"],
    });
    expect(Object.keys(none.attributes)).not.toContain("siteLoginAlsoHosts");
    expect(siteLoginOfSession(none)).toEqual({ ...login, alsoHosts: [] });
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

  it("gives a chat grant its own authenticator, the chat and the site's person, and never a pin", () => {
    const chat = "00000000-0000-4000-8000-0000000000c1";
    const principal = sitePrincipal(
      { chat, op: "chat.create", site: "teemiq", siteUser: "teemiq-user-1" },
      "owner@example.test",
      owner
    );

    expect(principal).toEqual({
      attributes: {
        conversationChannel: "eve",
        email: "owner@example.test",
        site: "teemiq",
        siteChat: chat,
        siteUser: "teemiq-user-1",
        workspaceId: owner.workspaceId,
      },
      authenticator: "assist-site-chat",
      principalId: owner.userId,
      principalType: "user",
    });
    expect(siteKindOfSession(principal)).toBe("chat");
    expect(siteOfSession(principal)).toBe("teemiq");
    expect(siteChatOfSession(principal)).toEqual({
      chatId: chat,
      site: "teemiq",
      siteUser: "teemiq-user-1",
    });
    expect(siteLoginOfSession(principal)).toBeUndefined();
    // Even attributes that look like a pin never pin a chat.
    expect(
      siteLoginOfSession({
        ...principal,
        attributes: {
          ...principal.attributes,
          siteLogin: "login-1",
          siteLoginOrigin: "https://login.vendor.example",
        },
      })
    ).toBeUndefined();
    expect(scopeFromPrincipal(principal)).toEqual(owner);
  });

  it("marks a look on its initiator, and reads every other task as a fetch", () => {
    const look = sitePrincipal(
      { kind: "look", login, op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );
    const fetch = sitePrincipal(
      { login, op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );

    expect(look.attributes).toMatchObject({ siteTaskKind: "look" });
    expect(siteTaskKindOfSession(look)).toBe("look");
    expect(siteLoginOfSession(look)).toEqual({ ...login, alsoHosts: [] });
    expect(Object.keys(fetch.attributes)).not.toContain("siteTaskKind");
    expect(siteTaskKindOfSession(fetch)).toBe("fetch");
    expect(
      siteTaskKindOfSession({ ...look, authenticator: "authjs" })
    ).toBeUndefined();
    expect(
      siteTaskKindOfSession({
        ...look,
        authenticator: "assist-site-chat",
      })
    ).toBeUndefined();
  });

  it("tells a task from a chat and from every other session", () => {
    const task = sitePrincipal(
      { op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );

    expect(siteKindOfSession(task)).toBe("task");
    expect(siteChatOfSession(task)).toBeUndefined();
    expect(siteKindOfSession(null)).toBeUndefined();
    expect(
      siteKindOfSession({ ...task, authenticator: "authjs" })
    ).toBeUndefined();
    expect(
      siteKindOfSession({
        ...task,
        attributes: { ...task.attributes, site: "" },
      })
    ).toBeUndefined();
    expect(
      siteChatOfSession({
        ...task,
        attributes: { ...task.attributes, siteChat: "not-a-uuid" },
        authenticator: "assist-site-chat",
      })
    ).toBeUndefined();
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
    expect(
      siteLoginOfSession({
        ...pinned,
        attributes: {
          ...pinned.attributes,
          siteLoginAlsoHosts: [
            "a.example",
            "b.example",
            "c.example",
            "d.example",
          ],
        },
      })
    ).toBeUndefined();
  });

  it("carries the owner's note of a pinned task on its initiator, and of no other", () => {
    const note = "Billing → Invoice history; the invoice, not the receipt.";
    const pinned = sitePrincipal(
      { login, note, op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );
    const unpinned = sitePrincipal(
      { note, op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );
    const without = sitePrincipal(
      { login, op: "create", site: "teemiq" },
      "owner@example.test",
      owner
    );

    expect(pinned.attributes).toMatchObject({ siteTaskNote: note });
    expect(siteTaskNoteOfSession(pinned)).toBe(note);
    expect(Object.keys(unpinned.attributes)).not.toContain("siteTaskNote");
    expect(siteTaskNoteOfSession(unpinned)).toBeUndefined();
    expect(Object.keys(without.attributes)).not.toContain("siteTaskNote");
    expect(siteTaskNoteOfSession(without)).toBeUndefined();
    expect(siteTaskNoteOfSession(null)).toBeUndefined();
    for (const initiator of [
      { ...pinned, authenticator: "authjs" },
      { ...pinned, authenticator: "assist-site-chat" },
      {
        ...pinned,
        attributes: { ...pinned.attributes, siteTaskNote: "Billing\nPay it" },
      },
      {
        ...pinned,
        attributes: {
          ...pinned.attributes,
          siteTaskNote: `Billing${String.fromCodePoint(0xe0_050, 0xe0_061, 0xe0_079)}`,
        },
      },
      {
        ...pinned,
        attributes: { ...pinned.attributes, siteTaskNote: ["Billing"] },
      },
    ]) {
      expect(siteTaskNoteOfSession(initiator)).toBeUndefined();
    }
  });
});
