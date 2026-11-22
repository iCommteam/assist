import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Database from "@db";
import type { AccessScope } from "@shared/identity/access-scope";
import { serializeLoginVaultPayload } from "@shared/vault/schema";

const store = vi.hoisted(() => new Map<string, string>());

// The encrypted-secret table as an in-memory map keyed by workspace and id.
vi.mock("@db/services/secrets", () => ({
  async deleteEncryptedSecret(scope: AccessScope, id: string) {
    store.delete(`${scope.workspaceId}/${id}`);
  },
  async readEncryptedSecret(scope: AccessScope, id: string) {
    return store.get(`${scope.workspaceId}/${id}`);
  },
  async writeEncryptedSecret(scope: AccessScope, id: string, value: string) {
    store.set(`${scope.workspaceId}/${id}`, value);
  },
}));
vi.mock("@db/services/scope", () => ({
  async ensureScope() {
    return undefined;
  },
}));

// Node's AES-GCM refusal for a wrong key, tag, AAD or ciphertext.
const unauthenticated = "Unsupported state or unable to authenticate data";

import { readVaultSecret, saveVaultItem } from "@db/services/vault";

const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };
const secret = serializeLoginVaultPayload({
  authentication: { password: "correct horse battery", type: "password" },
  identifier: { type: "email", value: "alice@example.com" },
  kind: "login",
  origin: "https://example.com",
  version: 2,
});

async function savedCiphertext() {
  await saveVaultItem(alice, {
    account: "alice@example.com",
    kind: "login",
    label: "Example",
    secret,
  });
  const [entry] = [...store.entries()];
  if (!entry) throw new Error("No ciphertext was written.");
  const [key, value] = entry;
  return { id: key.slice(`${alice.workspaceId}/`.length), value };
}

function replacePart(value: string, index: number, part: Buffer) {
  const parts = value.split(".");
  parts[index] = part.toString("base64url");
  return parts.join(".");
}

beforeEach(() => {
  store.clear();
  // SAFETY: saveVaultItem writes its record with db.insert(...).values(...) only.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a minimal insert stub stands in for the database driver
  const database = {
    insert: () => ({ values: async () => undefined }),
  } as never;
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vault encryption", () => {
  it("round-trips a secret as v1 AES-256-GCM with a 12-byte IV and 16-byte tag", async () => {
    const { id, value } = await savedCiphertext();

    const [version, iv, tag, ciphertext] = value.split(".");
    expect(version).toBe("v1");
    expect(Buffer.from(iv ?? "", "base64url")).toHaveLength(12);
    expect(Buffer.from(tag ?? "", "base64url")).toHaveLength(16);
    expect(ciphertext).not.toContain("correct");
    expect(await readVaultSecret(alice, id)).toBe(secret);
  });

  it("rejects a tampered ciphertext or tag", async () => {
    const { id, value } = await savedCiphertext();
    const key = `${alice.workspaceId}/${id}`;
    const [, , tag = "", ciphertext = ""] = value.split(".");

    const flipped = Buffer.from(ciphertext, "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 0x01;
    store.set(key, replacePart(value, 3, flipped));
    await expect(readVaultSecret(alice, id)).rejects.toThrow(unauthenticated);

    const badTag = Buffer.from(tag, "base64url");
    badTag[15] = (badTag[15] ?? 0) ^ 0x80;
    store.set(key, replacePart(value, 2, badTag));
    await expect(readVaultSecret(alice, id)).rejects.toThrow(unauthenticated);
  });

  it("rejects a truncated tag instead of checking fewer bytes", async () => {
    const { id, value } = await savedCiphertext();
    const [, , tag = ""] = value.split(".");

    store.set(
      `${alice.workspaceId}/${id}`,
      replacePart(value, 2, Buffer.from(tag, "base64url").subarray(0, 12))
    );
    await expect(readVaultSecret(alice, id)).rejects.toThrow(
      "Invalid authentication tag length: 12"
    );
  });

  it("binds each ciphertext to its workspace and item id", async () => {
    const { id, value } = await savedCiphertext();

    store.set(`${bob.workspaceId}/${id}`, value);
    await expect(readVaultSecret(bob, id)).rejects.toThrow(unauthenticated);

    const otherId = "00000000-0000-4000-8000-000000000042";
    store.set(`${alice.workspaceId}/${otherId}`, value);
    await expect(readVaultSecret(alice, otherId)).rejects.toThrow(
      unauthenticated
    );

    expect(await readVaultSecret(alice, id)).toBe(secret);
  });

  it("refuses an unknown format", async () => {
    const { id, value } = await savedCiphertext();
    store.set(`${alice.workspaceId}/${id}`, value.replace(/^v1\./u, "v2."));
    await expect(readVaultSecret(alice, id)).rejects.toThrow(
      "The stored secret uses an unsupported format."
    );
  });
});
