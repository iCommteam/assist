"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { authClient } from "@web/auth/client";
import {
  authErrorMessage,
  authUnavailableMessage,
} from "@app/(auth)/_lib/auth-error";
import { formValue } from "@app/(auth)/_lib/form-value";
import { Button } from "@web/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";

const minimumPasswordLength = 12;
const twoFactorRedirectSchema = z.looseObject({
  twoFactorRedirect: z.literal(true),
});

export function SignUpForm() {
  const router = useRouter();
  const signUp = useMutation({
    mutationFn: async (input: {
      readonly confirmation: string;
      readonly email: string;
      readonly password: string;
      readonly signupCode: string;
    }) => {
      if (input.password.length < minimumPasswordLength) {
        throw new Error("Use a password of at least 12 characters.");
      }
      if (input.password !== input.confirmation) {
        throw new Error("The two passwords do not match.");
      }
      // signUp.email() is typed without extra fields; the server reads the
      // signup code from this request body.
      const created = await authClient
        .$fetch("/sign-up/email", {
          body: {
            email: input.email,
            name: input.email,
            password: input.password,
            signupCode: input.signupCode,
          },
          method: "POST",
        })
        .catch(() => {
          throw new Error(authUnavailableMessage);
        });
      if (created.error) {
        throw new Error(
          authErrorMessage(created.error, "The account could not be created.")
        );
      }
      // Sign-up never starts a session; signing in here does, and fails for
      // an email that already had an account with a different password.
      const signedIn = await authClient.signIn
        .email({ email: input.email, password: input.password })
        .catch(() => {
          throw new Error(authUnavailableMessage);
        });
      if (signedIn.error) {
        throw new Error(
          "The account could not be opened with these details. If you already have an account, sign in instead."
        );
      }
      return twoFactorRedirectSchema.safeParse(signedIn.data).success;
    },
    onSuccess: (alreadyEnrolled) => {
      router.replace(alreadyEnrolled ? "/sign-in" : "/two-factor");
      router.refresh();
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        signUp.mutate({
          confirmation: formValue(form, "confirmation"),
          email: formValue(form, "email").trim(),
          password: formValue(form, "password"),
          signupCode: formValue(form, "signup-code").trim(),
        });
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Team email</FieldLabel>
          <Input
            autoComplete="username"
            id="email"
            name="email"
            required
            size="xl"
            type="email"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            autoComplete="new-password"
            id="password"
            minLength={minimumPasswordLength}
            name="password"
            required
            size="xl"
            type="password"
          />
          <FieldDescription>
            At least 12 characters. There is no password reset, so store it in a
            password manager.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="confirmation">Confirm password</FieldLabel>
          <Input
            autoComplete="new-password"
            id="confirmation"
            minLength={minimumPasswordLength}
            name="confirmation"
            required
            size="xl"
            type="password"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="signup-code">Signup code</FieldLabel>
          <Input
            autoComplete="off"
            id="signup-code"
            name="signup-code"
            required
            size="xl"
          />
        </Field>
        <FieldError errors={signUp.error ? [signUp.error] : undefined} />
        <Button className="w-full" disabled={signUp.isPending} type="submit">
          {signUp.isPending ? "Creating account…" : "Create account"}
        </Button>
        <p className="type-supporting-body text-muted-foreground">
          Already have an account?{" "}
          <Link className="underline underline-offset-4" href="/sign-in">
            Sign in
          </Link>
        </p>
      </FieldGroup>
    </form>
  );
}
