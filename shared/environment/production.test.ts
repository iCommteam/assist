import { describe, expect, it } from "vitest";
import { productionEnvironmentProblems } from "@shared/environment/production";

const secretValues = {
  ANTHROPIC_API_KEY: "sk-ant-test-value-that-must-not-leak",
  BETTER_AUTH_SECRET: "better-auth-secret-that-must-not-leak-0123",
  KERNEL_API_KEY: "kernel-key-that-must-not-leak",
  SCHEDULED_RUN_SECRET: "scheduled-run-secret-that-must-not-leak-01",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const complete = {
  ...secretValues,
  ASSIST_ALLOWED_EMAILS: "member@example.test",
  ASSIST_SIGNUP_CODE: "signup-code-0123456789",
  BETTER_AUTH_URL: "https://assist.example.test",
  DATABASE_URL: "postgresql://user:password@db.internal/assist",
  NODE_ENV: "production",
  PORT: "3000",
};

describe("production environment guard", () => {
  it("accepts a complete production environment", () => {
    expect(productionEnvironmentProblems(complete)).toEqual([]);
  });

  it("refuses anything but NODE_ENV=production", () => {
    expect(
      productionEnvironmentProblems({ ...complete, NODE_ENV: "development" })
    ).toEqual(['NODE_ENV must be "production".']);
    expect(
      productionEnvironmentProblems({ ...complete, NODE_ENV: undefined })
    ).toEqual(['NODE_ENV must be "production".']);
  });

  it.each([
    "AI_GATEWAY_API_KEY",
    "ANTHROPIC_BASE_URL",
    "BETTER_AUTH_SECRETS",
    "BETTER_AUTH_TRUSTED_ORIGINS",
    "BLOB_READ_WRITE_TOKEN",
    "BLOB_STORE_ID",
    "EVE_DEV",
    "EVE_NEXT_PRODUCTION_ORIGIN",
    "EVE_NEXT_PRODUCTION_PORT",
    "EVE_SCHEDULES_DISABLED",
    "KERNEL_BASE_URL",
    "LINK_CLIENT_ID",
    "LINQ_CONNECTOR",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "STRIPE_PUBLISHABLE_KEY",
    "TEST",
    "VERCEL",
    "VERCEL_ENV",
    "VERCEL_OIDC_TOKEN",
    "VERCEL_PROJECT_ID",
    "VERCEL_URL",
    "WORKFLOW_LOCAL_BASE_URL",
    "WORKFLOW_POSTGRES_URL",
  ])("refuses %s", (name) => {
    expect(
      productionEnvironmentProblems({ ...complete, [name]: "set-value-1" })
    ).toEqual([`${name} must be unset in production.`]);
  });

  it("treats an empty value as unset", () => {
    expect(
      productionEnvironmentProblems({ ...complete, EVE_DEV: " ", VERCEL: "" })
    ).toEqual([]);
  });

  it.each([
    "ANTHROPIC_API_KEY",
    "ASSIST_ALLOWED_EMAILS",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "DATABASE_URL",
    "KERNEL_API_KEY",
    "SCHEDULED_RUN_SECRET",
    "SECRET_ENCRYPTION_KEY",
  ])("requires %s", (name) => {
    expect(
      productionEnvironmentProblems({ ...complete, [name]: "  " })
    ).toEqual([`${name} is required.`]);
  });

  it("accepts an unset ASSIST_SIGNUP_CODE, which closes sign-up", () => {
    expect(
      productionEnvironmentProblems({ ...complete, ASSIST_SIGNUP_CODE: " " })
    ).toEqual([]);
  });

  it.each([
    [
      "BETTER_AUTH_SECRET",
      "openinstinct-local-auth-development-secret",
      "BETTER_AUTH_SECRET must not be the local development default.",
    ],
    [
      "BETTER_AUTH_SECRET",
      "too-short",
      "BETTER_AUTH_SECRET must contain at least 32 characters.",
    ],
    [
      "SECRET_ENCRYPTION_KEY",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "SECRET_ENCRYPTION_KEY must not be the all-zero key.",
    ],
    [
      "SECRET_ENCRYPTION_KEY",
      Buffer.alloc(16, 7).toString("base64"),
      "SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    ],
    [
      "ASSIST_SIGNUP_CODE",
      "short-code",
      "ASSIST_SIGNUP_CODE must contain at least 16 characters.",
    ],
    [
      "SCHEDULED_RUN_SECRET",
      "short-secret",
      "SCHEDULED_RUN_SECRET must contain at least 32 characters.",
    ],
  ])("refuses a weak %s", (name, value, problem) => {
    expect(
      productionEnvironmentProblems({ ...complete, [name]: value })
    ).toEqual([problem]);
  });

  it.each([
    "http://assist.example.test",
    "https://localhost:3000",
    "https://app.localhost",
    "https://127.0.0.1",
    "https://[::1]:3000",
    "https://0.0.0.0",
    "not a url",
  ])("refuses BETTER_AUTH_URL %s", (url) => {
    expect(
      productionEnvironmentProblems({ ...complete, BETTER_AUTH_URL: url })
    ).toEqual([
      "BETTER_AUTH_URL must be the public https origin, not a loopback address.",
    ]);
  });

  it("lists every problem and names variables, never their values", () => {
    const problems = productionEnvironmentProblems({
      ...secretValues,
      BETTER_AUTH_SECRET: "openinstinct-local-auth-development-secret",
      EVE_DEV: "1",
      NODE_ENV: "production",
      VERCEL_OIDC_TOKEN: "vercel-oidc-token-that-must-not-leak",
    });

    expect(problems).toEqual([
      "EVE_DEV must be unset in production.",
      "VERCEL_OIDC_TOKEN must be unset in production.",
      "DATABASE_URL is required.",
      "ASSIST_ALLOWED_EMAILS is required.",
      "BETTER_AUTH_SECRET must not be the local development default.",
      "BETTER_AUTH_URL is required.",
    ]);
    const text = problems.join("\n");
    for (const value of [
      ...Object.values(secretValues),
      "vercel-oidc-token-that-must-not-leak",
      "openinstinct-local-auth-development-secret",
    ]) {
      expect(text).not.toContain(value);
    }
  });
});
