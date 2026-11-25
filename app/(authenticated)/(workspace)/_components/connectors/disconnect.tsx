"use client";

import { useState } from "react";
import { z } from "zod";
import { Button } from "@web/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@web/components/ui/dialog";
import { Spinner } from "@web/components/ui/spinner";

const disconnectAnswerSchema = z.object({
  outcome: z.enum(["disconnected", "unrevoked"]),
});

// Disconnect asks once, then Google is told to revoke assist's access and
// assist deletes the account's tokens. The page reloads to say how it went.
export function GoogleDisconnect({ email }: { readonly email: string }) {
  const [state, setState] = useState<"failed" | "idle" | "working">("idle");
  const confirm = async () => {
    setState("working");
    if (!(await disconnect())) setState("failed");
  };
  return (
    <Dialog>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        Disconnect
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect Google?</DialogTitle>
          <DialogDescription>
            assist loses access to the mail, calendar and Drive of {email}, and
            Google is asked to revoke it. Your chats stay; you can connect again
            at any time.
          </DialogDescription>
        </DialogHeader>
        {state === "failed" ? (
          <output className="type-caption text-destructive">
            Google was not disconnected. Try again.
          </output>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            disabled={state === "working"}
            onClick={() => {
              void confirm();
            }}
            type="button"
            variant="destructive"
          >
            {state === "working" ? <Spinner /> : null}
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function disconnect() {
  try {
    const response = await fetch("/api/connectors/google/disconnect", {
      method: "POST",
    });
    const answer = disconnectAnswerSchema.safeParse(await response.json());
    if (!response.ok || !answer.success) return false;
    window.location.assign(`/?google=${answer.data.outcome}#connectors`);
    return true;
  } catch {
    return false;
  }
}
