import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthPage } from "@app/(auth)/_components/auth-page";
import { callbackUrlFrom } from "@app/(auth)/_lib/callback-url";
import { SignInForm } from "@app/(auth)/sign-in/_components/sign-in-form";
import {
  getAuthSession,
  getTwoFactorSetupSession,
} from "@db/services/auth/session";

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const params = await searchParams;
  const reauthenticate = params.reauthenticate === "true";
  const callbackUrl = callbackUrlFrom(params.callbackUrl);
  const requestHeaders = await headers();
  if (!reauthenticate && (await getAuthSession(requestHeaders))) {
    redirect(callbackUrl);
  }
  // A password-only session without an enrolled authenticator continues
  // straight to setup instead of asking for the password again.
  const setup = await getTwoFactorSetupSession(requestHeaders);
  if (setup && !setup.enrolled) {
    redirect(`/two-factor?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  return (
    <AuthPage
      description="Sign in with your team email, password and authenticator app."
      title={reauthenticate ? "Sign in again" : "Sign In"}
    >
      <SignInForm callbackUrl={callbackUrl} />
    </AuthPage>
  );
}
