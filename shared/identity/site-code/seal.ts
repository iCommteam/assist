import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

// A one-time code that a site relays to a paused task. The site API seals it
// before eve sees it, so eve's streams and workflow log, the browser trace and
// any model that a stale answer reaches hold only ciphertext. Only the browser
// worker's fill step in the task it was sealed for opens it.
const sealedPrefix = "assist-code.v1.";
const sealedLifetimeMs = 10 * 60_000;
const keyLabel = "icommassist/site-one-time-code/v1";
const ivBytes = 12;
const tagBytes = 16;

// A code as a person types it, such as 123456 or AB12-CD34: one line.
export const siteCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((code) => !/\p{Cc}/u.test(code));

const sealedPayloadSchema = z.strictObject({
  code: siteCodeSchema,
  exp: z.number().int().positive(),
});

export function sealSiteCode(secret: string, sessionId: string, code: string) {
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv("aes-256-gcm", codeKey(secret), iv);
  cipher.setAAD(additionalData(sessionId));
  const sealed = Buffer.concat([
    cipher.update(
      JSON.stringify({ code, exp: Date.now() + sealedLifetimeMs }),
      "utf8"
    ),
    cipher.final(),
  ]);
  return `${sealedPrefix}${Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url")}`;
}

// The code of an unexpired value sealed for this root session, or undefined.
export function openSiteCode(secret: string, sessionId: string, value: string) {
  if (!value.startsWith(sealedPrefix)) return undefined;
  const bytes = Buffer.from(value.slice(sealedPrefix.length), "base64url");
  if (bytes.length <= ivBytes + tagBytes) return undefined;
  let plain: string;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      codeKey(secret),
      bytes.subarray(0, ivBytes)
    );
    decipher.setAAD(additionalData(sessionId));
    decipher.setAuthTag(bytes.subarray(bytes.length - tagBytes));
    plain = Buffer.concat([
      decipher.update(bytes.subarray(ivBytes, bytes.length - tagBytes)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
  const payload = sealedPayloadSchema.safeParse(parseJson(plain));
  if (!payload.success || payload.data.exp <= Date.now()) return undefined;
  return payload.data.code;
}

function codeKey(secret: string) {
  return Buffer.from(hkdfSync("sha256", secret, "", keyLabel, 32));
}

function additionalData(sessionId: string) {
  return Buffer.from(`${sealedPrefix}${sessionId}`, "utf8");
}

function parseJson(text: string) {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}
