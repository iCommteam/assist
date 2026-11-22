import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthPage } from "@app/(auth)/_components/auth-page";
import { callbackUrlFrom } from "@app/(auth)/_lib/callback-url";
import { TwoFactorSetup } from "@app/(auth)/two-factor/_components/two-factor-setup";
import {
  getAuthSession,
  getTwoFactorSetupSession,
} from "@db/services/auth/session";

export default async function TwoFactorPage({
  searchParams,
}: PageProps<"/two-factor">) {
  const callbackUrl = callbackUrlFrom((await searchParams).callbackUrl);
  const requestHeaders = await headers();
  if (await getAuthSession(requestHeaders)) redirect(callbackUrl);
  const setup = await getTwoFactorSetupSession(requestHeaders);
  if (!setup) redirect("/sign-in");

  if (setup.enrolled) {
    return (
      <AuthPage
        description="This account already has an authenticator. Sign in again and enter a code from it."
        title="Sign In Again"
      >
        <Link
          className="type-label underline underline-offset-4"
          href="/sign-in"
        >
          Go to sign in
        </Link>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      description={`Every sign-in to ${setup.email} needs a code from an authenticator app, such as 1Password, Google Authenticator or Microsoft Authenticator.`}
      title="Set Up Authenticator"
    >
      <TwoFactorSetup callbackUrl={callbackUrl} />
    </AuthPage>
  );
}
