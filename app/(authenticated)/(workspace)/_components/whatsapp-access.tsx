"use client";

import { LockIcon, LockOpenIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import { api } from "@web/trpc/client";

// The member's WhatsApp numbers and whether full access is on, with one press
// to lock it or turn it back on; an administrator can also lock everyone.
export function WhatsappAccess({
  accounting,
  admin,
  lockedEveryone,
  lockedSelf,
  numbers,
}: {
  readonly accounting: boolean;
  readonly admin: boolean;
  readonly lockedEveryone: boolean;
  readonly lockedSelf: boolean;
  readonly numbers: readonly string[];
}) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const options = {
    onError: () => {
      setFailed(true);
    },
    onSuccess: () => {
      setFailed(false);
      router.refresh();
    },
  };
  const lock = api.whatsapp.lock.useMutation(options);
  const unlock = api.whatsapp.unlock.useMutation(options);
  const lockEveryone = api.whatsapp.lockEveryone.useMutation(options);
  const unlockEveryone = api.whatsapp.unlockEveryone.useMutation(options);
  const pending =
    lock.isPending ||
    unlock.isPending ||
    lockEveryone.isPending ||
    unlockEveryone.isPending;
  const on = !lockedSelf && !lockedEveryone;
  const what = accounting ? "Full access and Accounting" : "Full access";

  return (
    <div className="space-y-3">
      {numbers.length > 0 ? (
        <div className="divide-y divide-border/50 border-y border-border/50">
          {numbers.map((number) => (
            <div className="flex items-center gap-3 py-3" key={number}>
              <p className="min-w-0 flex-1 truncate type-label">{number}</p>
              <Badge variant={on ? "success" : "warning"}>
                {on ? `${what} on` : "Locked"}
              </Badge>
            </div>
          ))}
        </div>
      ) : (
        <p className="type-caption text-muted-foreground">
          No WhatsApp number is listed for you.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {numbers.length > 0 &&
          (lockedSelf ? (
            <Button
              disabled={pending || lockedEveryone}
              onClick={() => {
                unlock.mutate();
              }}
              variant="surface"
            >
              <LockOpenIcon />
              Turn back on
            </Button>
          ) : (
            <Button
              disabled={pending}
              onClick={() => {
                lock.mutate();
              }}
              variant="destructive"
            >
              <LockIcon />
              Lock
            </Button>
          ))}
        {admin &&
          (lockedEveryone ? (
            <Button
              disabled={pending}
              onClick={() => {
                unlockEveryone.mutate();
              }}
              variant="surface"
            >
              <LockOpenIcon />
              Turn everyone back on
            </Button>
          ) : (
            <Button
              disabled={pending}
              onClick={() => {
                lockEveryone.mutate();
              }}
              variant="destructive"
            >
              <LockIcon />
              Lock everyone
            </Button>
          ))}
      </div>
      <p className="type-caption text-muted-foreground">
        {lockedEveryone
          ? "An administrator locked WhatsApp for everyone: chats there are narrow until an administrator turns it back on."
          : lockedSelf
            ? "Your WhatsApp chats are narrow: no browser, vault, Personal Info, saved notes or Accounting. Turning it back on takes effect with your next message."
            : `${what} work in your WhatsApp chats. Lock ends those chats at once; you can also reply /lock on WhatsApp.`}
      </p>
      {failed && (
        <p className="type-caption text-destructive" role="alert">
          That did not go through. Try again.
        </p>
      )}
    </div>
  );
}
