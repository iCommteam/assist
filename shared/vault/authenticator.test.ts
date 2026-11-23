import { describe, expect, it } from "vitest";
import {
  authenticatorKeySchema,
  authenticatorSetupKeySchema,
} from "@shared/vault/authenticator";

const secret = "JBSWY3DPEHPK3PXP";
const defaults = { algorithm: "SHA1", digits: 6, period: 30 };

function parse(value: string) {
  return authenticatorSetupKeySchema.safeParse(value);
}

describe("authenticator setup keys", () => {
  it.each([
    ["a bare key", secret],
    ["a grouped lower-case key", "jbsw y3dp ehpk 3pxp"],
    ["a hyphenated key", "JBSW-Y3DP-EHPK-3PXP"],
    ["a padded key", "JBSWY3DPEHPK3PXP===="],
    ["surrounding whitespace", `  ${secret}\n`],
  ])("normalises %s with the RFC 6238 defaults", (_case, value) => {
    expect(parse(value).data).toEqual({ ...defaults, secret });
  });

  it("reads an otpauth link, keeping only the code parameters", () => {
    expect(
      parse(
        `otpauth://totp/ACME%20Co:john@example.com?secret=${secret.toLowerCase()}&issuer=ACME%20Co`
      ).data
    ).toEqual({ ...defaults, secret });
    expect(
      parse(
        `otpauth://totp/Vendor:ap@example.com?secret=${secret}&algorithm=sha512&digits=8&period=60`
      ).data
    ).toEqual({ algorithm: "SHA512", digits: 8, period: 60, secret });
    expect(
      parse(`OTPAUTH://TOTP?secret=${secret}&algorithm=SHA256`).data
    ).toEqual({ ...defaults, algorithm: "SHA256", secret });
  });

  it.each([
    ["an empty value", ""],
    [
      "a counter-based link",
      `otpauth://hotp/Vendor?secret=${secret}&counter=1`,
    ],
    ["a link without a secret", "otpauth://totp/Vendor?issuer=Vendor"],
    ["an unknown algorithm", `otpauth://totp/V?secret=${secret}&algorithm=MD5`],
    ["five digits", `otpauth://totp/V?secret=${secret}&digits=5`],
    ["nine digits", `otpauth://totp/V?secret=${secret}&digits=9`],
    [
      "a non-numeric digit count",
      `otpauth://totp/V?secret=${secret}&digits=6x`,
    ],
    ["a zero period", `otpauth://totp/V?secret=${secret}&period=0`],
    ["a period with a unit", `otpauth://totp/V?secret=${secret}&period=30s`],
    [
      "a repeated secret",
      `otpauth://totp/V?secret=${secret}&secret=GEZDGNBVGY3TQOJQ`,
    ],
    ["a web link", `https://vendor.example/2fa?secret=${secret}`],
    ["characters outside base32", "JBSWY3DPEHPK3PX0"],
    ["a key shorter than 80 bits", "JBSWY3DPEHPK3PX"],
    ["a key of an impossible length", "JBSWY3DPEHPK3PXPJ"],
  ])("rejects %s without echoing it", (_case, value) => {
    const messages = (parse(value).error?.issues ?? []).map(
      ({ message }) => message
    );
    expect(messages).not.toEqual([]);
    expect(messages.join(" ")).not.toContain(value.trim() || secret);
    expect(messages.join(" ")).not.toContain(secret);
  });

  it("stores only normalised keys", () => {
    expect(
      authenticatorKeySchema.safeParse({ ...defaults, secret }).success
    ).toBe(true);
    expect(
      authenticatorKeySchema.safeParse({
        ...defaults,
        secret: secret.toLowerCase(),
      }).success
    ).toBe(false);
    expect(
      authenticatorKeySchema.safeParse({ ...defaults, secret: `${secret}====` })
        .success
    ).toBe(false);
  });
});
