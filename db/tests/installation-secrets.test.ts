import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { get, put } from "@vercel/blob";

const mocks = vi.hoisted(() => ({
  get: vi.fn<typeof get>(),
  put: vi.fn<typeof put>(),
}));

vi.mock("@vercel/blob", () => ({
  get: mocks.get,
  put: mocks.put,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("BETTER_AUTH_SECRET", "");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test");
  vi.stubEnv("BLOB_STORE_ID", "store_openinstinct");
  vi.stubEnv("DATABASE_URL", "postgresql://user:password@example.com/database");
  vi.stubEnv("KERNEL_API_KEY", "test-kernel-key");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("installation secrets", () => {
  it("returns the configured pair", async () => {
    const configured = {
      betterAuthSecret: Buffer.alloc(32, 4).toString("base64"),
      secretEncryptionKey: Buffer.alloc(32, 5).toString("base64"),
    };
    vi.stubEnv("BETTER_AUTH_SECRET", configured.betterAuthSecret);
    vi.stubEnv("SECRET_ENCRYPTION_KEY", configured.secretEncryptionKey);

    const getInstallationSecrets = await loadInstallationSecrets();

    await expect(getInstallationSecrets()).resolves.toEqual(configured);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("never provisions secrets in Blob, even when a Blob store is configured", async () => {
    const getInstallationSecrets = await loadInstallationSecrets();

    await expect(getInstallationSecrets()).rejects.toThrow(
      "Installation secrets are unavailable. Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY."
    );
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("rejects a partial pair", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", Buffer.alloc(32, 6).toString("base64"));

    const getInstallationSecrets = await loadInstallationSecrets();

    await expect(getInstallationSecrets()).rejects.toThrow(
      "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY"
    );
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

async function loadInstallationSecrets() {
  const secretsModule = await import("@db/services/installation-secrets");
  return secretsModule.getInstallationSecrets;
}
