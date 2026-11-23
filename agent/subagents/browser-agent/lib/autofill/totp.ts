import { createHmac } from "node:crypto";
import type { AuthenticatorKey } from "@shared/vault/authenticator";

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// RFC 6238: the RFC 4226 code for the number of whole periods since the Unix
// epoch, at `now` in milliseconds.
export function authenticatorCode(key: AuthenticatorKey, now: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(
    BigInt(Math.floor(Math.floor(now / 1000) / key.period))
  );
  const digest = createHmac(
    key.algorithm.toLowerCase(),
    decodeBase32(key.secret)
  )
    .update(counter)
    .digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7f_ff_ff_ff;
  return String(binary % 10 ** key.digits).padStart(key.digits, "0");
}

function decodeBase32(secret: string) {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of secret) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) throw new Error("The authenticator setup key is invalid.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}
