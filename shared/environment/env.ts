import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { databaseUrlSchema } from "@shared/environment/database-url";
import { productionEnvironmentProblems } from "@shared/environment/production";

const betterAuthSecretSchema = z
  .string()
  .refine(
    (value) => value.trim().length >= 32,
    "BETTER_AUTH_SECRET must contain at least 32 characters."
  );

const secretEncryptionKeySchema = z
  .string()
  .refine(
    (value) => Buffer.from(value, "base64").length === 32,
    "SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key."
  );

const localDevelopment =
  process.env.NODE_ENV === "development" &&
  process.env.VERCEL_ENV === undefined;
const explicitBetterAuthSecret = hasValue(process.env.BETTER_AUTH_SECRET);
const explicitSecretEncryptionKey = hasValue(process.env.SECRET_ENCRYPTION_KEY);

if (
  localDevelopment &&
  explicitBetterAuthSecret !== explicitSecretEncryptionKey
) {
  throw new Error(
    "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY, or leave both unset for local defaults."
  );
}

const useLocalInstallationDefaults =
  localDevelopment && !explicitBetterAuthSecret && !explicitSecretEncryptionKey;

const requiredValue = z
  .string()
  .refine((value) => value.trim().length > 0, "Required");

const betterAuthUrlSchema = requiredValue.refine(
  (value) => URL.canParse(value),
  "BETTER_AUTH_URL must be an absolute URL"
);

// A comma-separated list, normalized to trimmed lower-case addresses so every
// comparison is case-insensitive. The error never echoes the configured values.
const emailListSchema = z.string().transform((value, context) => {
  const emails = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (emails.some((email) => !z.email().safeParse(email).success)) {
    context.addIssue({
      code: "custom",
      message: "Use valid email addresses separated by commas.",
    });
    return z.NEVER;
  }
  return emails;
});

const signupCodeSchema = requiredValue.refine(
  (value) => value.trim().length >= 16,
  "ASSIST_SIGNUP_CODE must contain at least 16 characters."
);

// An https URL, or plain http on this machine for local development.
const financeMcpUrlSchema = requiredValue.refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  );
}, "TEEMIQ_FINANCE_MCP_URL must be an https URL.");

const scheduledRunSecretSchema = requiredValue.refine(
  (value) => value.trim().length >= 32,
  "SCHEDULED_RUN_SECRET must contain at least 32 characters."
);

function optionalValueWithLocalDefault<T extends z.ZodType<string, string>>(
  schema: T,
  localDefault: z.util.NoUndefined<z.output<T>>
) {
  return localDevelopment ? schema.default(localDefault) : schema.optional();
}

function installationSecretWithLocalDefault<
  T extends z.ZodType<string, string>,
>(schema: T, localDefault: z.util.NoUndefined<z.output<T>>) {
  return useLocalInstallationDefaults
    ? schema.default(localDefault)
    : schema.optional();
}

export const env = createEnv({
  server: {
    // Required
    DATABASE_URL: databaseUrlSchema,
    KERNEL_API_KEY: requiredValue,

    // Optional overrides with local defaults. Production must set both secrets.
    BETTER_AUTH_SECRET: installationSecretWithLocalDefault(
      betterAuthSecretSchema,
      "openinstinct-local-auth-development-secret"
    ),
    BETTER_AUTH_URL: optionalValueWithLocalDefault(
      betterAuthUrlSchema,
      "http://localhost:3000"
    ),
    SECRET_ENCRYPTION_KEY: installationSecretWithLocalDefault(
      secretEncryptionKeySchema,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    ),

    // Team sign-in. Unset means closed: nobody can sign up or hold a session.
    ASSIST_ADMIN_EMAILS: emailListSchema.optional(),
    ASSIST_ALLOWED_EMAILS: emailListSchema.optional(),
    ASSIST_SIGNUP_CODE: signupCodeSchema.optional(),

    // The bearer secret of the loopback scheduled-run callbacks. Unset means
    // every callback is refused.
    SCHEDULED_RUN_SECRET: scheduledRunSecretSchema.optional(),

    // TEEMIQ's finance MCP route, which a site chat reaches with the token
    // TEEMIQ gave that chat. Unset means site chats have no finance tools.
    TEEMIQ_FINANCE_MCP_URL: financeMcpUrlSchema.optional(),

    // Optional
    // The co-located eve server's port in production, as `withEve` reads it.
    EVE_NEXT_PRODUCTION_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional(),
    BLOB_READ_WRITE_TOKEN: requiredValue.optional(),
    BLOB_STORE_ID: requiredValue.optional(),
    LINK_CLIENT_ID: requiredValue.optional(),
    LINK_CLIENT_SECRET: requiredValue.optional(),
    STRIPE_PUBLISHABLE_KEY: requiredValue.optional(),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("production"),
    VERCEL_BRANCH_URL: requiredValue.optional(),
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
    VERCEL_PROJECT_ID: requiredValue.optional(),
    VERCEL_PROJECT_PRODUCTION_URL: requiredValue.optional(),
    VERCEL_URL: requiredValue.optional(),
  },
  experimental__runtimeEnv: {},
  emptyStringAsUndefined: true,
});

// In a production process, throws unless the configuration passes the boot
// guard in ./production.ts; the message lists every problem by variable name.
// It reads NODE_ENV as set, not env.NODE_ENV, which defaults to production.
export function assertProductionEnvironment() {
  if (process.env.NODE_ENV !== "production") return;
  const problems = productionEnvironmentProblems(process.env);
  if (problems.length > 0) {
    throw new Error(`Refusing to run in production: ${problems.join(" ")}`);
  }
}

// Connected sites are configured by name rather than listed above:
// ASSIST_SITE_TOKEN_<SITE> holds a site's bearer token and
// ASSIST_SITE_OWNER_<SITE> the email of the member it acts for. Read on every
// call; shared/environment/sites.ts validates them.
const siteTokenVariablePattern =
  /^ASSIST_SITE_TOKEN_([A-Z0-9]+(?:_[A-Z0-9]+)*)$/u;

export function siteVariables() {
  return Object.entries(process.env).flatMap(([tokenVariable, value]) => {
    const suffix = siteTokenVariablePattern.exec(tokenVariable)?.[1];
    const token = value?.trim();
    if (!suffix || !token) return [];
    const ownerVariable = `ASSIST_SITE_OWNER_${suffix}`;
    return [
      {
        name: suffix.toLowerCase(),
        owner: process.env[ownerVariable]?.trim() ?? "",
        ownerVariable,
        token,
        tokenVariable,
      },
    ];
  });
}

function hasValue(value: string | undefined) {
  return value !== undefined && value.trim().length > 0;
}
