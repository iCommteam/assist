// The production boot guard. scripts/start.ts runs it before starting Next,
// and getInstallationSecrets runs it again in every production process, so a
// development switch, a Vercel leftover or a missing secret stops the service
// instead of quietly weakening it. Problems name variables, never values.
// scripts/start.ts loads this file with Node's own TypeScript support, which
// resolves no path aliases: keep it free of imports.

// Development switches, Vercel-only integrations and removed features. Each
// one either bypasses sign-in, sends data to Vercel, or changes where eve runs.
const refusedVariables = new Set([
  "AI_GATEWAY_API_KEY",
  // The bundled Anthropic provider sends every prompt, and the API key, to
  // this host instead of Anthropic's.
  "ANTHROPIC_BASE_URL",
  "BETTER_AUTH_SECRETS",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_STORE_ID",
  "EVE_DEV",
  "EVE_NEXT_PRODUCTION_ORIGIN",
  // Next's rewrite to eve is fixed at build time on port 4274, and the image
  // is built without this variable, so any runtime value splits the two.
  "EVE_NEXT_PRODUCTION_PORT",
  "EVE_SCHEDULES_DISABLED",
  "KERNEL_BASE_URL",
  "STRIPE_PUBLISHABLE_KEY",
  // The built eve server skips its schedule runner when TEST is set, so
  // scheduled jobs would stop without any error.
  "TEST",
  "VERCEL",
  "WORKFLOW_LOCAL_BASE_URL",
  "WORKFLOW_POSTGRES_URL",
]);
// No refused name or prefix covers TWILIO_* or ASSIST_WHATSAPP_NUMBERS: they
// configure the WhatsApp channel, and leaving them unset closes it.
const refusedPrefixes = ["LINK_", "LINQ_", "OTEL_EXPORTER_", "VERCEL_"];

const localAuthSecret = "openinstinct-local-auth-development-secret";
const loopbackHostname =
  /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/u;

export function productionEnvironmentProblems(
  environment: Readonly<Record<string, string | undefined>>
) {
  const value = (name: string) => {
    const configured = environment[name]?.trim();
    return configured === "" ? undefined : configured;
  };
  const problems: string[] = [];

  if (environment.NODE_ENV !== "production") {
    problems.push('NODE_ENV must be "production".');
  }

  const refused = Object.keys(environment)
    .filter(
      (name) =>
        value(name) !== undefined &&
        (refusedVariables.has(name) ||
          refusedPrefixes.some((prefix) => name.startsWith(prefix)))
    )
    .toSorted();
  for (const name of refused) {
    problems.push(`${name} must be unset in production.`);
  }

  for (const name of [
    "DATABASE_URL",
    "KERNEL_API_KEY",
    "ANTHROPIC_API_KEY",
    "ASSIST_ALLOWED_EMAILS",
  ]) {
    if (value(name) === undefined) problems.push(`${name} is required.`);
  }

  const authSecret = value("BETTER_AUTH_SECRET");
  if (authSecret === undefined) {
    problems.push("BETTER_AUTH_SECRET is required.");
  } else if (authSecret === localAuthSecret) {
    problems.push(
      "BETTER_AUTH_SECRET must not be the local development default."
    );
  } else if (authSecret.length < 32) {
    problems.push("BETTER_AUTH_SECRET must contain at least 32 characters.");
  }

  const encryptionKey = value("SECRET_ENCRYPTION_KEY");
  const keyBytes =
    encryptionKey === undefined
      ? undefined
      : Buffer.from(encryptionKey, "base64");
  if (keyBytes === undefined) {
    problems.push("SECRET_ENCRYPTION_KEY is required.");
  } else if (keyBytes.length !== 32) {
    problems.push(
      "SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key."
    );
  } else if (keyBytes.every((byte) => byte === 0)) {
    problems.push("SECRET_ENCRYPTION_KEY must not be the all-zero key.");
  }

  const authUrl = value("BETTER_AUTH_URL");
  const origin =
    authUrl !== undefined && URL.canParse(authUrl)
      ? new URL(authUrl)
      : undefined;
  if (authUrl === undefined) {
    problems.push("BETTER_AUTH_URL is required.");
  } else if (
    origin?.protocol !== "https:" ||
    loopbackHostname.test(origin.hostname)
  ) {
    problems.push(
      "BETTER_AUTH_URL must be the public https origin, not a loopback address."
    );
  }

  // Unset closes sign-up, which is a valid state once the team has accounts.
  const signupCode = value("ASSIST_SIGNUP_CODE");
  if (signupCode !== undefined && signupCode.length < 16) {
    problems.push("ASSIST_SIGNUP_CODE must contain at least 16 characters.");
  }

  const scheduledRunSecret = value("SCHEDULED_RUN_SECRET");
  if (scheduledRunSecret === undefined) {
    problems.push("SCHEDULED_RUN_SECRET is required.");
  } else if (scheduledRunSecret.length < 32) {
    problems.push("SCHEDULED_RUN_SECRET must contain at least 32 characters.");
  }

  return problems;
}
