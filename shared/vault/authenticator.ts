import { z } from "zod";

// The stored form of a login's authenticator-app setup key: the RFC 6238
// parameters with the secret as unpadded upper-case base32. Short keys of 16
// characters (80 bits) are common, so the RFC's 128-bit minimum is not held.
export const authenticatorKeySchema = z.object({
  algorithm: z.enum(["SHA1", "SHA256", "SHA512"]),
  digits: z.int().min(6).max(8),
  period: z.int().min(10).max(300),
  secret: z
    .string()
    .min(16)
    .max(256)
    .regex(/^[A-Z2-7]+$/u)
    // Unpadded base32 never leaves 1, 3 or 6 characters after whole blocks.
    .refine((value) => ![1, 3, 6].includes(value.length % 8)),
});

export type AuthenticatorKey = z.infer<typeof authenticatorKeySchema>;

const otpauthParameters = ["algorithm", "digits", "period", "secret"] as const;

// What a site shows during authenticator setup: an otpauth://totp/ link or the
// bare base32 key. The message never repeats the input, which is a secret.
export const authenticatorSetupKeySchema = z
  .string()
  .trim()
  .max(2_000)
  .transform((value, context) => {
    const key = /^otpauth:/iu.test(value)
      ? parseOtpauthUri(value)
      : authenticatorKeySchema.safeParse({
          algorithm: "SHA1",
          digits: 6,
          period: 30,
          secret: normalizeSecret(value),
        }).data;
    if (!key) {
      context.addIssue({
        code: "custom",
        message:
          "Enter the setup key or otpauth://totp/ link the site shows when you add an authenticator app.",
      });
      return z.NEVER;
    }
    return key;
  });

function parseOtpauthUri(value: string) {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  // A non-special scheme keeps the host's case: OTPAUTH://TOTP/ is still TOTP.
  if (url.protocol !== "otpauth:" || url.host.toLowerCase() !== "totp") {
    return undefined;
  }
  const { searchParams } = url;
  if (otpauthParameters.some((name) => searchParams.getAll(name).length > 1)) {
    return undefined;
  }
  return authenticatorKeySchema.safeParse({
    algorithm: (searchParams.get("algorithm") ?? "SHA1").toUpperCase(),
    digits: integerParameter(searchParams.get("digits"), 6),
    period: integerParameter(searchParams.get("period"), 30),
    secret: normalizeSecret(searchParams.get("secret") ?? ""),
  }).data;
}

function integerParameter(value: string | null, fallback: number) {
  if (value === null) return fallback;
  return /^\d{1,4}$/u.test(value) ? Number(value) : Number.NaN;
}

// Sites print keys in groups, sometimes lower-case or padded with "=".
function normalizeSecret(value: string) {
  return value.replaceAll(/[\s-]/gu, "").replace(/=+$/u, "").toUpperCase();
}
