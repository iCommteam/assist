import { describe, expect, it } from "vitest";
import { authenticatorCode } from "@agent/subagents/browser-agent/lib/autofill/totp";

// RFC 6238 Appendix B. Each algorithm has its own seed: the ASCII digits
// "1234567890" repeated to 20, 32 and 64 bytes, here in base32.
const seeds = {
  SHA1: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  SHA256: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA",
  SHA512:
    "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA",
} as const;

const vectors = [
  [59, "94287082", "46119246", "90693936"],
  [1_111_111_109, "07081804", "68084774", "25091201"],
  [1_111_111_111, "14050471", "67062674", "99943326"],
  [1_234_567_890, "89005924", "91819424", "93441116"],
  [2_000_000_000, "69279037", "90698825", "38618901"],
  [20_000_000_000, "65353130", "77737706", "47863826"],
] as const;

const cases = vectors.flatMap(([seconds, sha1, sha256, sha512]) =>
  (
    [
      ["SHA1", sha1],
      ["SHA256", sha256],
      ["SHA512", sha512],
    ] as const
  ).map(([algorithm, code]) => ({ algorithm, code, seconds }))
);

describe("authenticator codes", () => {
  it.each(cases)(
    "matches RFC 6238 for $algorithm at $seconds s with 8 digits",
    ({ algorithm, code, seconds }) => {
      expect(
        authenticatorCode(
          { algorithm, digits: 8, period: 30, secret: seeds[algorithm] },
          seconds * 1000
        )
      ).toBe(code);
    }
  );

  it.each(cases)(
    "keeps the last six digits for $algorithm at $seconds s",
    ({ algorithm, code, seconds }) => {
      expect(
        authenticatorCode(
          { algorithm, digits: 6, period: 30, secret: seeds[algorithm] },
          seconds * 1000
        )
      ).toBe(code.slice(-6));
    }
  );

  it("keeps a leading zero and changes only at a period boundary", () => {
    const key = {
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: seeds.SHA1,
    } as const;
    // 1111111109 s is the 8-digit 07081804, so its six digits are 081804.
    expect(authenticatorCode(key, 1_111_111_109_000)).toBe("081804");
    expect(authenticatorCode(key, 1_111_111_109_999)).toBe("081804");
    expect(authenticatorCode(key, 1_111_111_110_000)).toBe("050471");
    expect(authenticatorCode(key, 59_999)).toBe("287082");
    expect(authenticatorCode(key, 60_000)).not.toBe("287082");
  });

  it("uses the key's own period", () => {
    const key = {
      algorithm: "SHA1",
      digits: 8,
      period: 60,
      secret: seeds.SHA1,
    } as const;
    // At a 60-second period, 119 s is step 1, the 30-second code of 59 s.
    expect(authenticatorCode(key, 119_000)).toBe("94287082");
  });
});
