import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSiteCredential,
  mintSiteCredential,
  verifySiteCredential,
} from "@shared/identity/site-credential";

const secret = "site-credential-test-secret-0123456789";

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
