import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const productionEnvironment = {
  ANTHROPIC_API_KEY: "test-anthropic-key",
  ASSIST_ALLOWED_EMAILS: "member@example.test",
  ASSIST_SIGNUP_CODE: "test-signup-code-0123456789",
  BETTER_AUTH_SECRET: Buffer.alloc(32, 4).toString("base64"),
  BETTER_AUTH_URL: "https://assist.example.test",
  BLOB_READ_WRITE_TOKEN: "",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  KERNEL_API_KEY: "test-kernel-key",
  NODE_ENV: "production",
  SCHEDULED_RUN_SECRET: "test-scheduled-run-secret-0123456789abcdef",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
};

beforeEach(() => {
  vi.resetModules();
  for (const [name, value] of Object.entries(productionEnvironment)) {
    vi.stubEnv(name, value);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("installation secrets", () => {
  it("returns the configured pair in a complete production environment", async () => {
    const getInstallationSecrets = await loadInstallationSecrets();

    await expect(getInstallationSecrets()).resolves.toEqual({
      betterAuthSecret: productionEnvironment.BETTER_AUTH_SECRET,
      secretEncryptionKey: productionEnvironment.SECRET_ENCRYPTION_KEY,
    });
  });

  it("refuses every secret while the production guard fails", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test");
    vi.stubEnv("EVE_DEV", "1");

    const getInstallationSecrets = await loadInstallationSecrets();
    const failure = getInstallationSecrets();

    await expect(failure).rejects.toThrow(
      "Refusing to run in production: BLOB_READ_WRITE_TOKEN must be unset in production. EVE_DEV must be unset in production."
    );
    await expect(failure).rejects.not.toThrow("vercel_blob_rw_test");
  });

  it("rejects a partial pair outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "");

    const getInstallationSecrets = await loadInstallationSecrets();

    await expect(getInstallationSecrets()).rejects.toThrow(
      "Installation secrets are unavailable. Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY."
    );
  });
});

async function loadInstallationSecrets() {
  const secretsModule = await import("@db/services/installation-secrets");
  return secretsModule.getInstallationSecrets;
}
