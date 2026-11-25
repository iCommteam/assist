"use client";

import { LockIcon, LockOpenIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { WhatsappLink } from "./whatsapp-link";
import type { whatsappSection } from "../_data/whatsapp";
import { Badge } from "@web/components/ui/badge";
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
import { api } from "@web/trpc/client";

type Section = NonNullable<Awaited<ReturnType<typeof whatsappSection>>>;

// The member's WhatsApp: Connect WhatsApp while no number reaches them, and
// once one does, each number with whether full access is on and one press to
// lock it or turn it back on. A number the member linked can be
// disconnected; one ASSIST_WHATSAPP_NUMBERS sets cannot. An administrator
// also sees every connected number and can lock everyone.
export function WhatsappAccess({
  admin,
  connected,
  lockedEveryone,
  lockedSelf,
  numbers,
  sender,
}: Section) {
  const linked = numbers.find((entry) => entry.id !== null);
  const on = !lockedSelf && !lockedEveryone;

  return (
    <div className="space-y-6">
      {numbers.length === 0 ? (
        <div className="space-y-3">
          <p className="type-supporting-body text-muted-foreground">
            Message assist from your phone and it works for you, with the
            browser, vault links and your saved notes.
          </p>
          <WhatsappLink
            label="Connect WhatsApp"
            linkedId={null}
            prominent
            sender={sender}
          />
        </div>
      ) : (
        <div className="space-y-3">
          <ul className="divide-y divide-border/50 border-y border-border/50">
            {numbers.map((entry) => (
              <li
                className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3"
                key={entry.number}
              >
                <div className="flex-1">
                  <p className="type-label whitespace-nowrap">{entry.number}</p>
                  <p className="type-caption text-muted-foreground">
                    {entry.id === null
                      ? "Set by the server"
                      : `Connected since ${entry.since ?? ""}`}
                  </p>
                </div>
                <Badge variant={on ? "success" : "warning"}>
                  {on ? "Full access on" : "Locked"}
                </Badge>
                {entry.id !== null && (
                  <DisconnectButton
                    description={`Messages from ${entry.number} will no longer reach assist, and its WhatsApp chats end now. You can connect it again with a new code.`}
                    id={entry.id}
                    label={`Disconnect ${entry.number}`}
                  />
                )}
              </li>
            ))}
          </ul>
          <LockControls
            lockedEveryone={lockedEveryone}
            lockedSelf={lockedSelf}
          />
          {!linked && (
            <WhatsappLink
              label="Connect another number"
              linkedId={null}
              prominent={false}
              sender={sender}
            />
          )}
        </div>
      )}
      {admin && (
        <EveryoneNumbers
          connected={connected}
          lockedEveryone={lockedEveryone}
        />
      )}
    </div>
  );
}

function useRefreshing() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  return {
    failed,
    options: {
      onError: () => {
        setFailed(true);
      },
      onSuccess: () => {
        setFailed(false);
        router.refresh();
      },
    },
  };
}

function LockControls({
  lockedEveryone,
  lockedSelf,
}: {
  readonly lockedEveryone: boolean;
  readonly lockedSelf: boolean;
}) {
  const { failed, options } = useRefreshing();
  const lock = api.whatsapp.lock.useMutation(options);
  const unlock = api.whatsapp.unlock.useMutation(options);
  const pending = lock.isPending || unlock.isPending;

  return (
    <div className="space-y-2">
      {lockedSelf ? (
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
      )}
      <p className="type-caption text-muted-foreground">
        {lockedEveryone
          ? "An administrator locked WhatsApp for everyone: chats there are narrow until an administrator turns it back on."
          : lockedSelf
            ? "Your WhatsApp chats are narrow: no browser, vault, Personal Info or saved notes. Turning it back on takes effect with your next message."
            : "Full access works in your WhatsApp chats. Lock ends those chats at once; you can also reply /lock on WhatsApp."}
      </p>
      {failed && <FailedLine />}
    </div>
  );
}

// An administrator's view: every connected number, partly hidden, and the
// lock for everyone.
function EveryoneNumbers({
  connected,
  lockedEveryone,
}: {
  readonly connected: Section["connected"];
  readonly lockedEveryone: boolean;
}) {
  const { failed, options } = useRefreshing();
  const lockEveryone = api.whatsapp.lockEveryone.useMutation(options);
  const unlockEveryone = api.whatsapp.unlockEveryone.useMutation(options);
  const pending = lockEveryone.isPending || unlockEveryone.isPending;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="type-label">Everyone&apos;s numbers</h3>
        {lockedEveryone ? (
          <Button
            disabled={pending}
            onClick={() => {
              unlockEveryone.mutate();
            }}
            size="sm"
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
            size="sm"
            variant="destructive"
          >
            <LockIcon />
            Lock everyone
          </Button>
        )}
      </div>
      {failed && <FailedLine />}
      {connected.length === 0 ? (
        <p className="type-caption text-muted-foreground">
          No number is connected yet.
        </p>
      ) : (
        <ul className="divide-y divide-border/50 border-y border-border/50">
          {connected.map((entry) => (
            <li className="flex items-center gap-3 py-2.5" key={entry.key}>
              <div className="min-w-0 flex-1">
                <p className="truncate type-label">{entry.email}</p>
                <p className="type-caption text-muted-foreground">
                  <span className="whitespace-nowrap">{entry.number}</span>
                  {" · "}
                  {entry.id === null
                    ? "Set by the server"
                    : `Linked ${entry.since ?? ""}`}
                </p>
              </div>
              {entry.id !== null && (
                <DisconnectButton
                  description={`Messages from ${entry.number} will no longer reach assist as ${entry.email}, and its WhatsApp chats end now.`}
                  id={entry.id}
                  label={`Disconnect ${entry.email}'s number`}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Disconnect, behind a confirm. It sends nothing on WhatsApp.
function DisconnectButton({
  description,
  id,
  label,
}: {
  readonly description: string;
  readonly id: string;
  readonly label: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const disconnect = api.whatsapp.disconnect.useMutation({
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={<Button aria-label={label} size="sm" variant="ghost" />}
      >
        Disconnect
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect this number?</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {disconnect.isError && <FailedLine />}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            disabled={disconnect.isPending}
            onClick={() => {
              disconnect.mutate({ id });
            }}
            variant="destructive"
          >
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FailedLine() {
  return (
    <p className="type-caption text-destructive" role="alert">
      That did not go through. Try again.
    </p>
  );
}
