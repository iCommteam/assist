"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
import { useHydrated } from "@web/hooks/use-hydrated";

const twoFactorRedirectSchema = z.looseObject({
  twoFactorRedirect: z.literal(true),
});

export function SignInForm({ callbackUrl }: { readonly callbackUrl: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [secondFactor, setSecondFactor] = useState(false);
  const signIn = useMutation({
    mutationFn: async (credentials: {
      readonly email: string;
      readonly password: string;
    }) => {
      const result = await authClient.signIn
        .email({ email: credentials.email, password: credentials.password })
        .catch(() => {
          throw new Error(authUnavailableMessage);
        });
      if (result.error) {
        throw new Error(
          authErrorMessage(result.error, "The email or password is incorrect.")
        );
      }
      return twoFactorRedirectSchema.safeParse(result.data).success;
    },
    onSuccess: (needsSecondFactor) => {
      if (needsSecondFactor) {
        setSecondFactor(true);
        return;
      }
      // The password was right but no authenticator is enrolled yet.
      router.replace(
        `/two-factor?callbackUrl=${encodeURIComponent(callbackUrl)}`
      );
    },
  });

  if (secondFactor) {
    return (
      <SecondFactorForm
        onStartOver={() => {
          signIn.reset();
          setSecondFactor(false);
        }}
        onVerified={() => {
          router.replace(callbackUrl);
          router.refresh();
        }}
      />
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        signIn.mutate({
          email: formValue(event.currentTarget, "email").trim(),
          password: formValue(event.currentTarget, "password"),
        });
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
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
            autoComplete="current-password"
            id="password"
            name="password"
            required
            size="xl"
            type="password"
          />
        </Field>
        <FieldError errors={signIn.error ? [signIn.error] : undefined} />
        <Button
          className="w-full"
          disabled={!hydrated || signIn.isPending}
          type="submit"
        >
          {signIn.isPending ? "Signing in…" : "Continue"}
        </Button>
        <p className="type-supporting-body text-muted-foreground">
          New to the team?{" "}
          <Link className="underline underline-offset-4" href="/sign-up">
            Create an account
          </Link>
        </p>
      </FieldGroup>
    </form>
  );
}

function SecondFactorForm({
  onStartOver,
  onVerified,
}: {
  readonly onStartOver: () => void;
  readonly onVerified: () => void;
}) {
  const [backupCode, setBackupCode] = useState(false);
  const verify = useMutation({
    mutationFn: async (code: string) => {
      const result = await (
        backupCode
          ? authClient.twoFactor.verifyBackupCode({ code })
          : authClient.twoFactor.verifyTotp({ code })
      ).catch(() => {
        throw new Error(authUnavailableMessage);
      });
      if (result.error) {
        throw new Error(
          authErrorMessage(result.error, "That code could not be verified.")
        );
      }
    },
    onSuccess: onVerified,
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        verify.mutate(formValue(event.currentTarget, "code").trim());
      }}
    >
      <FieldGroup>
        {backupCode ? (
          <Field>
            <FieldLabel htmlFor="code">Backup code</FieldLabel>
            <Input
              autoComplete="off"
              id="code"
              key="backup-code"
              name="code"
              required
              size="xl"
            />
            <FieldDescription>Each backup code works once.</FieldDescription>
          </Field>
        ) : (
          <Field>
            <FieldLabel htmlFor="code">Authenticator code</FieldLabel>
            <Input
              autoComplete="one-time-code"
              id="code"
              inputMode="numeric"
              key="totp-code"
              maxLength={6}
              name="code"
              pattern="[0-9]{6}"
              required
              size="xl"
            />
            <FieldDescription>
              Enter the six-digit code from your authenticator app.
            </FieldDescription>
          </Field>
        )}
        <FieldError errors={verify.error ? [verify.error] : undefined} />
        <Button className="w-full" disabled={verify.isPending} type="submit">
          {verify.isPending ? "Verifying…" : "Verify"}
        </Button>
        <Button
          className="w-full"
          disabled={verify.isPending}
          onClick={() => {
            verify.reset();
            setBackupCode((current) => !current);
          }}
          type="button"
          variant="ghost"
        >
          {backupCode ? "Use an authenticator code" : "Use a backup code"}
        </Button>
        <Button
          className="w-full"
          disabled={verify.isPending}
          onClick={onStartOver}
          type="button"
          variant="ghost"
        >
          Start over
        </Button>
      </FieldGroup>
    </form>
  );
}
