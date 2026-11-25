import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

// A token a connected service gave one chat, kept encrypted in that chat's
// row: AES-256-GCM under a key derived from the installation's secret key for
// one purpose (`label`), bound to `aad`, so a sealed token copied to another
// row, or read for another purpose, never opens.
const tokenPrefix = "v1.";
const ivBytes = 12;
const tagBytes = 16;

export function sealToken(
  secretEncryptionKey: string,
  label: string,
  aad: string,
  token: string
) {
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv(
    "aes-256-gcm",
    tokenKey(secretEncryptionKey, label),
    iv,
    { authTagLength: tagBytes }
  );
  cipher.setAAD(Buffer.from(aad));
  const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${tokenPrefix}${Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url")}`;
}

// The token, or undefined when the value does not open under this key, label
// and aad.
export function openToken(
  secretEncryptionKey: string,
  label: string,
  aad: string,
  value: string
) {
  if (!value.startsWith(tokenPrefix)) return undefined;
  const bytes = Buffer.from(value.slice(tokenPrefix.length), "base64url");
  if (bytes.length <= ivBytes + tagBytes) return undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      tokenKey(secretEncryptionKey, label),
      bytes.subarray(0, ivBytes),
      { authTagLength: tagBytes }
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(bytes.subarray(bytes.length - tagBytes));
    return Buffer.concat([
      decipher.update(bytes.subarray(ivBytes, bytes.length - tagBytes)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
}

function tokenKey(secretEncryptionKey: string, label: string) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secretEncryptionKey, "base64"),
      "",
      label,
      32
    )
  );
}
