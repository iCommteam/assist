import { z } from "zod";
import { getAuth } from "@db/services/auth";
import { isAllowedEmail } from "./allowlist";

const authenticatedSessionSchema = z.looseObject({
  session: z.looseObject({ twoFactorVerified: z.literal(true) }),
  user: z.looseObject({
    email: z.string().min(1),
    id: z.string().min(1),
    twoFactorEnabled: z.literal(true),
  }),
});

const signedInSessionSchema = z.looseObject({
  session: z.looseObject({ twoFactorVerified: z.boolean().nullish() }),
  user: z.looseObject({
    email: z.string().min(1),
    twoFactorEnabled: z.boolean().nullish(),
  }),
});

// The single identity check for pages, tRPC, the proxy and the eve channel. A
// session counts only for a listed email whose authenticator is enrolled and
// that proved a TOTP or backup code when this session was created.
export async function getAuthSession(headers: Headers) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers });
  const parsed = authenticatedSessionSchema.safeParse(session);
  return parsed.success && isAllowedEmail(parsed.data.user.email)
    ? parsed.data
    : null;
}

// Only the authenticator setup page reads this: a listed member who signed in
// with a password but has not completed a second factor in this session.
export async function getTwoFactorSetupSession(headers: Headers) {
  const auth = await getAuth();
  const parsed = signedInSessionSchema.safeParse(
    await auth.api.getSession({ headers })
  );
  if (
    !parsed.success ||
    parsed.data.session.twoFactorVerified === true ||
    !isAllowedEmail(parsed.data.user.email)
  ) {
    return null;
  }
  return {
    email: parsed.data.user.email,
    enrolled: parsed.data.user.twoFactorEnabled === true,
  };
}
