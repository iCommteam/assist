"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@web/components/ui/button";
import { Spinner } from "@web/components/ui/spinner";
import { GoogleDisconnect } from "./disconnect";
import { postToConnector } from "./post";

const startAnswerSchema = z.object({ url: z.url() });

// The Google row's buttons: Connect Google or Reconnect, which asks assist
// for this member's consent URL and opens Google's consent screen in this
// tab, and Disconnect. Google returns to the Workspace page, which says how
// it went. A failure to open Google shows on its own line under the row.
export function GoogleActions({
  connectLabel,
  email,
}: {
  readonly connectLabel: string | undefined;
  readonly email: string | undefined;
}) {
  const router = useRouter();
  const [state, setState] = useState<"failed" | "idle" | "opening">("idle");
  const connect = async () => {
    setState("opening");
    const opened = await openConsent();
    if (opened === "signed-out") {
      // The proxy sends the reload to the sign-in page, and back here after.
      window.location.reload();
    } else if (opened === "unavailable") {
      setState("idle");
      router.replace("/?google=unavailable#connectors", { scroll: false });
      router.refresh();
    } else if (opened === "failed") {
      setState("failed");
    }
  };
  return (
    <>
      <div className="flex shrink-0 items-center gap-2">
        {connectLabel === undefined ? null : (
          <Button
            disabled={state === "opening"}
            onClick={() => {
              void connect();
            }}
            size="sm"
            type="button"
          >
            {state === "opening" ? <Spinner /> : null}
            {connectLabel}
          </Button>
        )}
        {email === undefined ? null : <GoogleDisconnect email={email} />}
      </div>
      {state === "failed" ? (
        <output className="basis-full pl-12 type-caption text-destructive">
          Google could not be opened. Try again.
        </output>
      ) : null}
    </>
  );
}

async function openConsent() {
  try {
    const answer = await postToConnector("/api/connectors/google/start");
    if (answer.signedOut) return "signed-out";
    if (answer.status === 409) return "unavailable";
    const start = startAnswerSchema.safeParse(answer.body);
    if (answer.status !== 200 || !start.success) return "failed";
    window.location.assign(start.data.url);
    return "opened";
  } catch {
    return "failed";
  }
}
