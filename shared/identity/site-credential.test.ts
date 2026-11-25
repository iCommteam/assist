import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  isSiteCredential,
  mintSiteCredential,
  verifySiteCredential,
} from "@shared/identity/site-credential";

const secret = "site-credential-test-secret-0123456789";
// Minting signs whatever it is given, so a grant the schema refuses still
// reaches the verifier with a valid signature.
const uncheckedGrant = z.custom<Parameters<typeof mintSiteCredential>[1]>();

describe("site channel credential", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-22T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries its grant to a verifier holding the same secret", () => {
    const create = mintSiteCredential(secret, { op: "create", site: "teemiq" });
    const read = mintSiteCredential(secret, {
      op: "read",
      session: "wrun_1",
      site: "teemiq",
    });

    expect(isSiteCredential(create)).toBe(true);
    expect(verifySiteCredential(secret, create)).toEqual({
      op: "create",
      site: "teemiq",
    });
    expect(verifySiteCredential(secret, read)).toEqual({
      op: "read",
      session: "wrun_1",
      site: "teemiq",
    });
  });

  it("carries a create grant's login pin, and refuses a malformed one", () => {
    const login = { id: "login-1", origin: "https://login.vendor.example" };
    const pinned = mintSiteCredential(secret, {
      login,
      op: "create",
      site: "teemiq",
    });
    const pathOrigin = mintSiteCredential(secret, {
      login: { id: "login-1", origin: "https://login.vendor.example/billing" },
      op: "create",
      site: "teemiq",
    });

    expect(verifySiteCredential(secret, pinned)).toEqual({
      login,
      op: "create",
      site: "teemiq",
    });
    expect(verifySiteCredential(secret, pathOrigin)).toBeUndefined();
  });

  it("carries a look on a create grant, and nothing else as its kind", () => {
    const login = { id: "login-1", origin: "https://login.vendor.example" };
    const look = { kind: "look", login, op: "create", site: "teemiq" } as const;

    expect(
      verifySiteCredential(secret, mintSiteCredential(secret, look))
    ).toEqual(look);
    expect(
      verifySiteCredential(
        secret,
        mintSiteCredential(
          secret,
          uncheckedGrant.parse({ ...look, kind: "fetch" })
        )
      )
    ).toBeUndefined();
  });

  it("carries the owner's note on a create grant, and refuses a note of the wrong shape", () => {
    const login = { id: "login-1", origin: "https://login.vendor.example" };
    const note = "Billing → Invoice history; the invoice, not the receipt.";
    const grant = { login, note, op: "create", site: "teemiq" } as const;

    expect(
      verifySiteCredential(secret, mintSiteCredential(secret, grant))
    ).toEqual(grant);
    for (const wrong of [
      "",
      "x".repeat(301),
      "Billing\nPay it",
      `${String.fromCodePoint(0x20_2e)}Billing`,
      // Every format character but the two direction marks, a lone
      // surrogate and a private-use character: tag characters spell words
      // no one sees.
      `Billing${String.fromCodePoint(0xe0_020, 0xe0_050, 0xe0_061, 0xe0_079)}`,
      `Billing${String.fromCodePoint(0x20_0b)}Invoices`,
      `Billing${String.fromCodePoint(0x06_1c)}Invoices`,
      `Bill${String.fromCodePoint(0xfe_ff)}ing`,
      `${String.fromCodePoint(0xfe_ff)}Billing`,
      `Billing${String.fromCodePoint(0xd8_00)}`,
      `Billing${String.fromCodePoint(0xe0_00)}`,
      // Every other default-ignorable character too: a variation selector,
      // an emoji's among them, a grapheme joiner, a filler, a Mongolian
      // variation selector, one past the BMP, and one not yet assigned.
      `Billing ✔${String.fromCodePoint(0xfe_0f)}`,
      `Billing${String.fromCodePoint(0x03_4f)}Invoices`,
      `Billing ${String.fromCodePoint(0x31_64)}Invoices`,
      `${String.fromCodePoint(0x11_5f)}Billing`,
      `Billing${String.fromCodePoint(0x18_0b)}`,
      `Billing${String.fromCodePoint(0xe0_100)}`,
      `Billing${String.fromCodePoint(0xff_f0)}`,
      "Send it to billing@vendor.example",
      // An email address reads as one with a mark, an invisible space or an
      // accent inside it.
      `Send it to billing@${String.fromCodePoint(0x20_0e)}vendor.example`,
      `Send it to billing@vendor${String.fromCodePoint(0x20_0f)}.example`,
      `Send it to billing@vendor${String.fromCodePoint(0x20_0b)}.example`,
      `Send it to billing@vendo${String.fromCodePoint(0x03_01)}r.example`,
      // Or with a look-alike @ or dot, as it reads once folded: fullwidth,
      // small, or a one dot leader.
      `Send it to billing${String.fromCodePoint(0xff_20)}vendor${String.fromCodePoint(0xff_0e)}example`,
      `Send it to billing@vendor${String.fromCodePoint(0xff_0e)}example`,
      `Send it to billing${String.fromCodePoint(0xfe_6b)}vendor.example`,
      `Send it to billing@vendor${String.fromCodePoint(0x20_24)}example`,
      `Send it to billing@vendor${String.fromCodePoint(0xfe_52)}example`,
      // Or as typed, though the marks it is made of read as nothing.
      `Send it to ${String.fromCodePoint(0x20_0e)}@${String.fromCodePoint(0x20_0e)}.${String.fromCodePoint(0x20_0e)}`,
    ]) {
      expect(
        verifySiteCredential(
          secret,
          mintSiteCredential(
            secret,
            uncheckedGrant.parse({ ...grant, note: wrong })
          )
        )
      ).toBeUndefined();
    }
    // The two direction marks are the only characters that show nothing a
    // note keeps: Hebrew text carries them.
    for (const kept of [
      `חשבוניות${String.fromCodePoint(0x20_0f)} ← חיוב`,
      `${String.fromCodePoint(0x20_0e)}Billing${String.fromCodePoint(0x20_0e)}`,
      String.fromCodePoint(0x20_0e),
    ]) {
      const keptGrant = { ...grant, note: kept };
      expect(
        verifySiteCredential(secret, mintSiteCredential(secret, keptGrant))
      ).toEqual(keptGrant);
    }
  });

  it("binds an answer grant to one question of one session", () => {
    const answer = mintSiteCredential(secret, {
      interaction: "interaction-1",
      op: "answer",
      session: "wrun_1",
      site: "teemiq",
    });
    const [prefix, payload, signature] = splitCredential(answer);
    const unbound = Buffer.from(
      Buffer.from(payload, "base64url")
        .toString("utf8")
        .replace('"interaction":"interaction-1",', ""),
      "utf8"
    ).toString("base64url");

    expect(verifySiteCredential(secret, answer)).toEqual({
      interaction: "interaction-1",
      op: "answer",
      session: "wrun_1",
      site: "teemiq",
    });
    expect(
      verifySiteCredential(secret, `${prefix}${unbound}.${signature}`)
    ).toBeUndefined();
  });

  it("carries a cancel grant bound to one session", () => {
    const cancel = mintSiteCredential(secret, {
      op: "cancel",
      session: "wrun_1",
      site: "teemiq",
    });

    expect(verifySiteCredential(secret, cancel)).toEqual({
      op: "cancel",
      session: "wrun_1",
      site: "teemiq",
    });
  });

  it("binds every chat grant to one chat of one site's person, and each but create to its session", () => {
    const chat = "00000000-0000-4000-8000-0000000000c1";
    const grants = [
      { chat, op: "chat.create", site: "teemiq", siteUser: "user-1" },
      {
        chat,
        op: "chat.message",
        session: "wrun_1",
        site: "teemiq",
        siteUser: "user-1",
      },
      {
        chat,
        interaction: "interaction-1",
        op: "chat.answer",
        session: "wrun_1",
        site: "teemiq",
        siteUser: "user-1",
      },
      {
        chat,
        op: "chat.read",
        session: "wrun_1",
        site: "teemiq",
        siteUser: "user-1",
      },
      {
        chat,
        op: "chat.cancel",
        session: "wrun_1",
        site: "teemiq",
        siteUser: "user-1",
      },
    ] as const;

    for (const grant of grants) {
      expect(
        verifySiteCredential(secret, mintSiteCredential(secret, grant))
      ).toEqual(grant);
      const { siteUser: _siteUser, ...unbound } = grant;
      expect(
        verifySiteCredential(
          secret,
          mintSiteCredential(secret, uncheckedGrant.parse(unbound))
        )
      ).toBeUndefined();
    }
    const { session: _session, ...sessionless } = grants[1];
    expect(
      verifySiteCredential(
        secret,
        mintSiteCredential(secret, uncheckedGrant.parse(sessionless))
      )
    ).toBeUndefined();
  });

  it.each([
    ["a chat id that is not a uuid", { chat: "chat-1" }],
    ["a site user with a space", { siteUser: "user 1" }],
    ["an empty site user", { siteUser: "" }],
    ["a login pin", { login: { id: "l", origin: "https://a.example" } }],
  ])("refuses a chat grant with %s", (_case, change) => {
    const grant = {
      chat: "00000000-0000-4000-8000-0000000000c1",
      op: "chat.create",
      site: "teemiq",
      siteUser: "user-1",
      ...change,
    };

    expect(
      verifySiteCredential(
        secret,
        mintSiteCredential(secret, uncheckedGrant.parse(grant))
      )
    ).toBeUndefined();
  });

  it("refuses a credential signed with another secret", () => {
    const credential = mintSiteCredential(`${secret}-other`, {
      op: "create",
      site: "teemiq",
    });

    expect(verifySiteCredential(secret, credential)).toBeUndefined();
  });

  it("refuses a credential whose grant was changed after signing", () => {
    const credential = mintSiteCredential(secret, {
      op: "read",
      session: "wrun_own",
      site: "teemiq",
    });
    const [prefix, payload, signature] = splitCredential(credential);
    const forged = Buffer.from(
      Buffer.from(payload, "base64url")
        .toString("utf8")
        .replace("wrun_own", "wrun_victim"),
      "utf8"
    ).toString("base64url");

    expect(
      verifySiteCredential(secret, `${prefix}${forged}.${signature}`)
    ).toBeUndefined();
  });

  it("refuses a login pin added to a credential after signing", () => {
    const credential = mintSiteCredential(secret, {
      op: "create",
      site: "teemiq",
    });
    const [prefix, payload, signature] = splitCredential(credential);
    const claims = z
      .object({ exp: z.number(), grant: z.object({}).loose() })
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const forged = Buffer.from(
      JSON.stringify({
        ...claims,
        grant: {
          ...claims.grant,
          login: { id: "login-1", origin: "https://login.vendor.example" },
        },
      }),
      "utf8"
    ).toString("base64url");

    expect(
      verifySiteCredential(secret, `${prefix}${forged}.${signature}`)
    ).toBeUndefined();
  });

  it("expires one minute after it is minted", () => {
    const credential = mintSiteCredential(secret, {
      op: "create",
      site: "teemiq",
    });

    vi.advanceTimersByTime(59_000);
    expect(verifySiteCredential(secret, credential)).toBeDefined();
    vi.advanceTimersByTime(1_000);
    expect(verifySiteCredential(secret, credential)).toBeUndefined();
  });

  it.each([
    "",
    "Bearer token",
    "assist-site.v1.",
    "assist-site.v1.payload",
    "assist-site.v1.payload.signature.extra",
    "assist-site.v2.payload.signature",
  ])("refuses the malformed credential %j", (credential) => {
    expect(verifySiteCredential(secret, credential)).toBeUndefined();
  });
});

function splitCredential(credential: string) {
  const prefix = "assist-site.v1.";
  const [payload = "", signature = ""] = credential
    .slice(prefix.length)
    .split(".");
  return [prefix, payload, signature] as const;
}
