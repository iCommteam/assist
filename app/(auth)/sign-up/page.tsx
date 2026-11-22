import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthPage } from "@app/(auth)/_components/auth-page";
import { SignUpForm } from "@app/(auth)/sign-up/_components/sign-up-form";
import { getAuthSession } from "@db/services/auth/session";

export default async function SignUpPage() {
  if (await getAuthSession(await headers())) redirect("/");

  return (
    <AuthPage
      description="Use your team email and the signup code from your administrator. You will set up an authenticator app next."
      title="Create Account"
    >
      <SignUpForm />
    </AuthPage>
  );
}
