// Client copy for Better Auth error codes. No message says whether an email is
// on the team list: unlisted emails get the same text as wrong credentials.
const messages = new Map([
  ["INVALID_EMAIL_OR_PASSWORD", "The email or password is incorrect."],
  ["SIGN_UP_REJECTED", "This email and signup code cannot create an account."],
  ["PASSWORD_TOO_SHORT", "Use a password of at least 12 characters."],
  ["PASSWORD_TOO_LONG", "Use a password of at most 128 characters."],
  ["INVALID_PASSWORD", "The password is incorrect."],
  ["INVALID_CODE", "That code did not work. Check your authenticator app."],
  ["INVALID_BACKUP_CODE", "That backup code did not work."],
  [
    "INVALID_TWO_FACTOR_COOKIE",
    "This sign-in expired. Start again with your email and password.",
  ],
  [
    "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
    "Too many wrong codes. Start again with your email and password.",
  ],
  [
    "ACCOUNT_TEMPORARILY_LOCKED",
    "Too many wrong codes. Wait 15 minutes, then try again.",
  ],
  [
    "TOTP_ALREADY_ENABLED",
    "Your authenticator is already set up. Sign out, then sign in again.",
  ],
]);

export function authErrorMessage(
  error: { readonly code?: string; readonly status?: number },
  fallback: string
) {
  if (error.status === 429) {
    return "Too many attempts. Wait a minute, then try again.";
  }
  return (error.code ? messages.get(error.code) : undefined) ?? fallback;
}

export const authUnavailableMessage =
  "Sign-in is unavailable right now. Try again in a moment.";
