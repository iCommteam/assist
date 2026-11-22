import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor as twoFactorPlugin } from "better-auth/plugins/two-factor";
import { z } from "zod";
import { account, db, session, twoFactor, user, verification } from "@db";
import { betterAuthBaseURL } from "@shared/environment/origin";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { isAllowedEmail, signupCodeMatches } from "./allowlist";

// One answer for an unlisted email and a wrong or missing code, so a caller
// without the code learns nothing about the team list.
const signUpRejected = {
  code: "SIGN_UP_REJECTED",
  message: "This email and signup code cannot create an account.",
};
// Better Auth's own wrong-password error, so a refused session is
// indistinguishable from bad credentials.
const signInRejected = {
  code: "INVALID_EMAIL_OR_PASSWORD",
  message: "Invalid email or password",
};
// The only endpoints that create a session after a second factor succeeded.
const twoFactorVerifyPaths = new Set([
  "/two-factor/verify-backup-code",
  "/two-factor/verify-totp",
]);

const signUpBodySchema = z.looseObject({
  email: z.string(),
  signupCode: z.string(),
});
const trustDeviceBodySchema = z.looseObject({ trustDevice: z.literal(true) });
const sessionUserSchema = z.looseObject({
  email: z.string(),
  twoFactorEnabled: z.boolean().nullish(),
});

let authPromise: ReturnType<typeof initializeAuth> | undefined;

export function getAuth() {
  authPromise ??= initializeAuthWithRetry();
  return authPromise;
}

async function initializeAuthWithRetry() {
  try {
    return await initializeAuth();
  } catch (error) {
    authPromise = undefined;
    throw error;
  }
}

async function initializeAuth() {
  const { betterAuthSecret } = await getInstallationSecrets();
  return betterAuth({
    appName: "iCommAssist",
    baseURL: betterAuthBaseURL(),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { account, session, twoFactor, user, verification },
    }),
    // There is no mailer: no verification email and no self-serve reset.
    // app/api/auth/[...all]/route.ts exposes only the endpoints the sign-in
    // pages call; every other Better Auth path answers 404 there.
    emailAndPassword: {
      autoSignIn: false,
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 12,
      requireEmailVerification: false,
    },
    session: {
      additionalFields: {
        twoFactorVerified: {
          defaultValue: false,
          input: false,
          required: false,
          type: "boolean",
        },
      },
      // A session idle for 24 hours ends; activity extends it hourly.
      expiresIn: 60 * 60 * 24,
      updateAge: 60 * 60,
    },
    // Better Auth limits only in production. Memory storage suits the single
    // replica. The client IP comes from X-Forwarded-For only when that header
    // holds exactly one address, because no trustedProxies are set. Railway's
    // edge header format is unverified: if it forwards several hops, every
    // client shares one bucket per path. That throttles the team but cannot be
    // bypassed with a spoofed header. Never set disableIpTracking, which turns
    // rate limiting off.
    rateLimit: {
      customRules: {
        "/sign-in/email": { max: 5, window: 60 },
        "/sign-up/email": { max: 5, window: 600 },
        "/two-factor/enable": { max: 5, window: 60 },
        "/two-factor/verify-backup-code": { max: 5, window: 60 },
        "/two-factor/verify-totp": { max: 5, window: 60 },
      },
      storage: "memory",
    },
    account: {
      encryptOAuthTokens: true,
      additionalFields: {
        issuer: {
          type: "string",
          required: true,
          input: false,
          defaultValue: "better-auth",
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Checked before Better Auth looks the email up, so a caller without
        // the code cannot tell registered emails from the rest.
        if (
          ctx.path === "/sign-up/email" &&
          !signUpAllowed(signUpBodySchema.safeParse(ctx.body).data)
        ) {
          throw APIError.from("BAD_REQUEST", signUpRejected);
        }
        // A trusted device would skip TOTP on later sign-ins.
        if (
          twoFactorVerifyPaths.has(ctx.path) &&
          trustDeviceBodySchema.safeParse(ctx.body).success
        ) {
          throw APIError.from("BAD_REQUEST", {
            code: "TRUST_DEVICE_DISABLED",
            message: "Every sign-in needs an authenticator code.",
          });
        }
      }),
    },
    databaseHooks: {
      account: {
        create: {
          before: async (value) => ({
            data: { ...value, issuer: value.providerId },
          }),
        },
      },
      user: {
        create: {
          // A backstop for the request hook: users are created only by an
          // email sign-up that carries the right code for a listed email.
          // Not a 403, which Better Auth turns into a fake success.
          before: async (value, context) => {
            if (
              context?.path !== "/sign-up/email" ||
              !signUpAllowed(signUpBodySchema.safeParse(context.body).data) ||
              !isAllowedEmail(value.email)
            ) {
              throw APIError.from("BAD_REQUEST", signUpRejected);
            }
          },
        },
      },
      session: {
        create: {
          before: async (value, context) => {
            const found = sessionUserSchema.safeParse(
              await context?.context.internalAdapter.findUserById(value.userId)
            );
            if (
              !context ||
              !found.success ||
              !isAllowedEmail(found.data.email)
            ) {
              throw APIError.from("UNAUTHORIZED", signInRejected);
            }
            return {
              data: {
                ...value,
                twoFactorVerified:
                  found.data.twoFactorEnabled === true &&
                  twoFactorVerifyPaths.has(context.path),
              },
            };
          },
        },
      },
    },
    plugins: [
      twoFactorPlugin({
        backupCodeOptions: { storeBackupCodes: "encrypted" },
        issuer: "iCommAssist",
      }),
    ],
    secret: betterAuthSecret,
  });
}

// Both checks always run, so the response time does not reveal which failed.
function signUpAllowed(body: z.infer<typeof signUpBodySchema> | undefined) {
  const emailAllowed = body !== undefined && isAllowedEmail(body.email);
  const codeMatches = body !== undefined && signupCodeMatches(body.signupCode);
  return emailAllowed && codeMatches;
}
