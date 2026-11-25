"use client";

import { useRouter } from "next/navigation";
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
import { postToConnector } from "./post";

const disconnectAnswerSchema = z.object({
  outcome: z.enum(["disconnected", "unrevoked"]),
});

// Disconnect asks once, then Google is told to revoke assist's access and
// assist deletes the account's tokens. The dialog closes, the section reloads
// in place and says how it went. A failure shows only for the attempt that
// failed: each opening starts clean.
export function GoogleDisconnect({ email }: { readonly email: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"failed" | "idle" | "working">("idle");
  const confirm = async () => {
    setState("working");
    const outcome = await disconnect();
    if (outcome === "signed-out") {
      // The proxy sends the reload to the sign-in page, and back here after.
      window.location.reload();
      return;
    }
    if (outcome === "failed") {
      setState("failed");
      return;
    }
    setOpen(false);
    setState("idle");
    router.replace(`/?google=${outcome}#connectors`, { scroll: false });
    router.refresh();
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setState("idle");
      }}
      open={open}
    >
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
    const answer = await postToConnector("/api/connectors/google/disconnect");
    if (answer.signedOut) return "signed-out";
    const parsed = disconnectAnswerSchema.safeParse(answer.body);
    if (answer.status !== 200 || !parsed.success) return "failed";
    return parsed.data.outcome;
  } catch {
    return "failed";
  }
}
