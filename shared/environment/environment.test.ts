import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://example.com",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  KERNEL_API_KEY: "test-kernel-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("environment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [name, value] of Object.entries(requiredEnvironment)) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("ASSIST_ADMIN_EMAILS", "");
    vi.stubEnv("ASSIST_ALLOWED_EMAILS", "");
    vi.stubEnv("ASSIST_SIGNUP_CODE", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("exports the validated environment", async () => {
    const { env } = await import("@shared/environment");

    expect(env).toMatchObject(requiredEnvironment);
  });

  it("leaves team sign-in closed by default", async () => {
    const { env } = await import("@shared/environment");

    expect(env.ASSIST_ADMIN_EMAILS).toBeUndefined();
    expect(env.ASSIST_ALLOWED_EMAILS).toBeUndefined();
    expect(env.ASSIST_SIGNUP_CODE).toBeUndefined();
  });

  it("normalizes the team email lists to trimmed lower-case addresses", async () => {
    vi.stubEnv(
      "ASSIST_ALLOWED_EMAILS",
      " Alice@Example.test, bob@example.test ,,"
    );
    vi.stubEnv("ASSIST_ADMIN_EMAILS", "ALICE@example.test");

    const { env } = await import("@shared/environment");

    expect(env.ASSIST_ALLOWED_EMAILS).toEqual([
      "alice@example.test",
      "bob@example.test",
    ]);
    expect(env.ASSIST_ADMIN_EMAILS).toEqual(["alice@example.test"]);
  });

  it.each([
    ["ASSIST_ALLOWED_EMAILS", "alice@example.test, not-an-email"],
    ["ASSIST_ADMIN_EMAILS", "alice"],
    ["ASSIST_SIGNUP_CODE", "too-short"],
    ["TEEMIQ_FINANCE_MCP_URL", "http://team.example/api/mcp/finance"],
    ["TEEMIQ_FINANCE_MCP_URL", "team.example/api/mcp/finance"],
    ["TWILIO_ACCOUNT_SID", "SK00000000000000000000000000000000"],
    ["TWILIO_ACCOUNT_SID", "AC0000"],
    ["TWILIO_WHATSAPP_FROM", "+15551234567"],
    ["TWILIO_WHATSAPP_FROM", "whatsapp:15551234567"],
    ["TEEMIQ_WHATSAPP_URL", "http://team.example"],
    ["TEEMIQ_WHATSAPP_URL", "https://team.example/api/mcp/finance-wa"],
    ["TEEMIQ_WHATSAPP_URL", "team.example"],
    ["ASSIST_WHATSAPP_VOUCH_TOKEN", "too-short"],
  ])("rejects an invalid %s during import", async (name, value) => {
    vi.stubEnv(name, value);

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("reads TEEMIQ's finance MCP URL over https, or http on this machine, and leaves it unset by default", async () => {
    const { env: unset } = await import("@shared/environment");
    expect(unset.TEEMIQ_FINANCE_MCP_URL).toBeUndefined();

    for (const url of [
      "https://team.example/api/mcp/finance",
      "http://localhost:3000/api/mcp/finance",
    ]) {
      vi.resetModules();
      vi.stubEnv("TEEMIQ_FINANCE_MCP_URL", url);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each URL needs a fresh import.
      const { env } = await import("@shared/environment");
      expect(env.TEEMIQ_FINANCE_MCP_URL).toBe(url);
    }
  });

  it("leaves WhatsApp closed by default and reads its Twilio account when set", async () => {
    const { env: unset, whatsappNumbersVariable } =
      await import("@shared/environment");
    expect(unset.TWILIO_ACCOUNT_SID).toBeUndefined();
    expect(unset.TWILIO_AUTH_TOKEN).toBeUndefined();
    expect(unset.TWILIO_WHATSAPP_FROM).toBeUndefined();
    expect(whatsappNumbersVariable()).toBe("");

    vi.resetModules();
    const twilio = {
      TWILIO_ACCOUNT_SID: `AC${"0123456789abcdef".repeat(2)}`,
      TWILIO_AUTH_TOKEN: "test-twilio-auth-token",
      TWILIO_WHATSAPP_FROM: "whatsapp:+15551234567",
    };
    for (const [name, value] of Object.entries(twilio)) {
      vi.stubEnv(name, value);
    }
    const { env } = await import("@shared/environment");
    expect(env).toMatchObject(twilio);
  });

  it("leaves Accounting on WhatsApp off unless TEEMIQ's origin and the vouch bearer are both set", async () => {
    const vouchToken = "vouch-token-0123456789abcdefghijklmnopqrstuv";
    const { whatsappAccountingConfig: unset } =
      await import("@shared/environment");
    expect(unset()).toBeUndefined();

    for (const [url, token, expected] of [
      ["https://team.example", undefined, undefined],
      [undefined, vouchToken, undefined],
      [
        "https://team.example/",
        vouchToken,
        { origin: "https://team.example", token: vouchToken },
      ],
    ] as const) {
      vi.resetModules();
      vi.stubEnv("TEEMIQ_WHATSAPP_URL", url);
      vi.stubEnv("ASSIST_WHATSAPP_VOUCH_TOKEN", token);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each configuration needs a fresh import.
      const { whatsappAccountingConfig } = await import("@shared/environment");
      expect(whatsappAccountingConfig()).toEqual(expected);
    }
  });

  it.each([
    "BETTER_AUTH_SECRET",
    "TWILIO_AUTH_TOKEN",
    "ASSIST_SITE_TOKEN_TEEMIQ",
  ])(
    "refuses a vouch bearer equal to %s, without logging either",
    async (other) => {
      const shared = "shared-secret-0123456789abcdefghijklmnopqrstuv";
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      vi.stubEnv(other, shared);
      vi.stubEnv("TEEMIQ_WHATSAPP_URL", "https://team.example");
      vi.stubEnv("ASSIST_WHATSAPP_VOUCH_TOKEN", shared);

      const { whatsappAccountingConfig } = await import("@shared/environment");

      expect(whatsappAccountingConfig()).toBeUndefined();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(shared);
    }
  );

  it("reads the WhatsApp members on every call", async () => {
    const { whatsappNumbersVariable } = await import("@shared/environment");

    vi.stubEnv("ASSIST_WHATSAPP_NUMBERS", " +15551234567=a@example.test ");
    expect(whatsappNumbersVariable()).toBe("+15551234567=a@example.test");
    vi.stubEnv("ASSIST_WHATSAPP_NUMBERS", "");
    expect(whatsappNumbersVariable()).toBe("");
  });

  it("provides stable auth and encryption defaults in local development", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", undefined);

    const { env } = await import("@shared/environment");

    expect(env).toMatchObject({
      BETTER_AUTH_SECRET: "openinstinct-local-auth-development-secret",
      BETTER_AUTH_URL: "http://localhost:3000",
      SECRET_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
  });

  it.each([
    ["test-auth-secret-0123456789abcdefghijklmnop", ""],
    ["", Buffer.alloc(32, 2).toString("base64")],
  ])(
    "rejects asymmetric local installation-secret overrides",
    async (betterAuthSecret, secretEncryptionKey) => {
      vi.stubEnv("BETTER_AUTH_SECRET", betterAuthSecret);
      vi.stubEnv("SECRET_ENCRYPTION_KEY", secretEncryptionKey);
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("VERCEL_ENV", undefined);

      await expect(import("@shared/environment")).rejects.toThrow(
        "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY"
      );
    }
  );

  it("does not provide local defaults in a Vercel development environment", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("VERCEL_URL", "open-instinct-preview.vercel.app");

    const { env } = await import("@shared/environment");

    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.BETTER_AUTH_URL).toBeUndefined();
    expect(env.SECRET_ENCRYPTION_KEY).toBeUndefined();
  });

  it.each(["DATABASE_URL", "KERNEL_API_KEY"])(
    "keeps %s required in local development",
    async (name) => {
      vi.stubEnv(name, "");
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("VERCEL_ENV", undefined);

      await expect(import("@shared/environment")).rejects.toThrow(
        "Invalid environment variables"
      );
    }
  );

  it.each([
    requiredEnvironment.SECRET_ENCRYPTION_KEY.slice(0, -1),
    Buffer.alloc(32, 255).toString("base64url"),
  ])("accepts a Node-compatible 32-byte encryption key", async (key) => {
    vi.stubEnv("SECRET_ENCRYPTION_KEY", key);

    const { env } = await import("@shared/environment");
    expect(env.SECRET_ENCRYPTION_KEY).toBe(key);
  });

  it.each([
    ["DATABASE_URL", "Invalid environment variables"],
    ["KERNEL_API_KEY", "Invalid environment variables"],
  ])(
    "rejects a missing required %s value during import",
    async (name, errorMessage) => {
      vi.stubEnv(name, "");

      await expect(import("@shared/environment")).rejects.toThrow(errorMessage);
    }
  );

  it("rejects an encryption key that does not decode to 32 bytes", async () => {
    vi.stubEnv("SECRET_ENCRYPTION_KEY", Buffer.alloc(31, 1).toString("base64"));

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("rejects a non-Postgres database URL", async () => {
    vi.stubEnv("DATABASE_URL", "https://example.com/database");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("accepts Vercel OIDC Blob storage without a static token", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BLOB_STORE_ID", "store_openinstinct");

    const { env } = await import("@shared/environment");

    expect(env.BLOB_READ_WRITE_TOKEN).toBeUndefined();
    expect(env.BLOB_STORE_ID).toBe("store_openinstinct");
  });
});
