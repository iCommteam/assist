"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { authClient } from "@web/auth/client";
import {
  authErrorMessage,
  authUnavailableMessage,
} from "@app/(auth)/_lib/auth-error";
import { formValue } from "@app/(auth)/_lib/form-value";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";
import { QrCode } from "./qr-code";

const enrolmentSchema = z.object({
  backupCodes: z.array(z.string()).min(1),
  totpURI: z.string().startsWith("otpauth://totp/"),
});

export function TwoFactorSetup({
  callbackUrl,
}: {
  readonly callbackUrl: string;
}) {
  const router = useRouter();
  const [verified, setVerified] = useState(false);
  const enable = useMutation({
    mutationFn: async (password: string) => {
      const result = await authClient.twoFactor
        .enable({ password })
        .catch(() => {
          throw new Error(authUnavailableMessage);
        });
      if (result.error) {
        throw new Error(
          authErrorMessage(
            result.error,
            "The authenticator could not be set up."
          )
        );
      }
      const enrolment = enrolmentSchema.safeParse(result.data);
      if (!enrolment.success) {
        throw new Error("The authenticator could not be set up.");
      }
      return enrolment.data;
    },
  });

  if (verified && enable.data) {
    return (
      <BackupCodes
        codes={enable.data.backupCodes}
        onContinue={() => {
          router.replace(callbackUrl);
          router.refresh();
        }}
      />
    );
  }

  if (enable.data) {
    return (
      <ScanAndVerify
        onVerified={() => {
          setVerified(true);
        }}
        totpUri={enable.data.totpURI}
      />
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        enable.mutate(formValue(event.currentTarget, "password"));
      }}
    >
      <FieldGroup>
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
          <FieldDescription>
            Confirm your password to create your authenticator key.
          </FieldDescription>
        </Field>
        <FieldError errors={enable.error ? [enable.error] : undefined} />
        <Button className="w-full" disabled={enable.isPending} type="submit">
          {enable.isPending ? "Creating key…" : "Continue"}
        </Button>
        <Button
          className="w-full"
          disabled={enable.isPending}
          onClick={() => {
            void authClient.signOut().finally(() => {
              window.location.assign("/sign-in");
            });
          }}
          type="button"
          variant="ghost"
        >
          Use a different account
        </Button>
      </FieldGroup>
    </form>
  );
}

function ScanAndVerify({
  onVerified,
  totpUri,
}: {
  readonly onVerified: () => void;
  readonly totpUri: string;
}) {
  const secret = new URL(totpUri).searchParams.get("secret") ?? "";
  const verify = useMutation({
    mutationFn: async (code: string) => {
      const result = await authClient.twoFactor
        .verifyTotp({ code })
        .catch(() => {
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
        <div className="flex flex-col items-center gap-3">
          <QrCode value={totpUri} />
          <p className="type-supporting-body text-muted-foreground">
            Scan the code with your authenticator app, or enter this key:
          </p>
          <p className="type-code break-all select-all" data-testid="totp-key">
            {secret.match(/.{1,4}/gu)?.join(" ") ?? secret}
          </p>
        </div>
        <Field>
          <FieldLabel htmlFor="code">Authenticator code</FieldLabel>
          <Input
            autoComplete="one-time-code"
            id="code"
            inputMode="numeric"
            maxLength={6}
            name="code"
            pattern="[0-9]{6}"
            required
            size="xl"
          />
          <FieldDescription>
            Enter the six-digit code the app shows to finish setup.
          </FieldDescription>
        </Field>
        <FieldError errors={verify.error ? [verify.error] : undefined} />
        <Button className="w-full" disabled={verify.isPending} type="submit">
          {verify.isPending ? "Verifying…" : "Verify"}
        </Button>
      </FieldGroup>
    </form>
  );
}

function BackupCodes({
  codes,
  onContinue,
}: {
  readonly codes: readonly string[];
  readonly onContinue: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="warning">
        <AlertTitle>Save your backup codes</AlertTitle>
        <AlertDescription>
          Each code signs you in once if you lose your authenticator. They are
          shown only now, and there is no other way back into this account.
        </AlertDescription>
      </Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-lg border border-border p-3">
        {codes.map((code) => (
          <li className="type-code select-all" key={code}>
            {code}
          </li>
        ))}
      </ul>
      <Button className="w-full" onClick={onContinue} type="button">
        I saved my backup codes
      </Button>
    </div>
  );
}
