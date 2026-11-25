"use client";

import { useState } from "react";
import { z } from "zod";
import { Button } from "@web/components/ui/button";
import { Spinner } from "@web/components/ui/spinner";

const startAnswerSchema = z.object({ url: z.url() });

// Connect Google (or Reconnect): asks assist for this member's consent URL,
// then opens Google's consent screen in this tab. Google returns to the
// Workspace page, which says how it went.
export function GoogleConnect({ label }: { readonly label: string }) {
  const [state, setState] = useState<"failed" | "idle" | "opening">("idle");
  const connect = async () => {
    setState("opening");
    if (!(await openConsent())) setState("failed");
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={state === "opening"}
        onClick={() => {
          void connect();
        }}
        size="sm"
        type="button"
      >
        {state === "opening" ? <Spinner /> : null}
        {label}
      </Button>
      {state === "failed" ? (
        <output className="type-caption text-destructive">
          Google could not be opened. Try again.
        </output>
      ) : null}
    </div>
  );
}

async function openConsent() {
  try {
    const response = await fetch("/api/connectors/google/start", {
      method: "POST",
    });
    const answer = startAnswerSchema.safeParse(await response.json());
    if (!response.ok || !answer.success) return false;
    window.location.assign(answer.data.url);
    return true;
  } catch {
    return false;
  }
}
