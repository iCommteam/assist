"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { MessageCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { QrCode } from "@app/_components/qr-code";
import { Button } from "@web/components/ui/button";
import { Card, CardContent } from "@web/components/ui/card";
import { Spinner } from "@web/components/ui/spinner";
import { api } from "@web/trpc/client";
import type { AppRouter } from "@web/trpc/router";

// The company's WhatsApp number, as wa.me wants it and as people read it.
interface Sender {
  readonly digits: string;
  readonly number: string;
}

type LinkStatus = inferRouterOutputs<AppRouter>["whatsapp"]["linkStatus"];

// What the card shows after a check: waiting for the message, the number
// connected, the code used by a message that connected nothing, or the code
// expired. WhatsApp's reply says why a used code connected nothing. Only a
// connected number or an expired code ends the checks: a link that lands as
// one check reads shows on the next.
export function linkPhase(
  status: LinkStatus | undefined,
  checkedAt: number,
  card: { readonly expiresAt: string; readonly linkedIdAtStart: string | null }
) {
  if (status === undefined) return "waiting";
  if (status.linkedId !== null && status.linkedId !== card.linkedIdAtStart) {
    return "connected";
  }
  if (status.codeLive) return "waiting";
  return checkedAt < Date.parse(card.expiresAt) ? "used" : "expired";
}

type LinkPhase = ReturnType<typeof linkPhase>;

// Connect WhatsApp: one press makes a link code, and the card shows how to
// send it. While the card is open the page asks every few seconds, and on
// focus, whether the number is linked, and shows it once it is.
export function WhatsappLink({
  label,
  linkedId,
  prominent,
  sender,
}: {
  readonly label: string;
  readonly linkedId: string | null;
  readonly prominent: boolean;
  readonly sender: Sender;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const [card, setCard] = useState<{
    readonly code: string;
    readonly expiresAt: string;
    readonly linkedIdAtStart: string | null;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const connectButton = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  const linkCode = api.whatsapp.linkCode.useMutation({
    onError: () => {
      setFailed(true);
    },
    onSuccess: async (made) => {
      await utils.whatsapp.linkStatus.reset();
      setFailed(false);
      setCard({ ...made, linkedIdAtStart: linkedId });
    },
  });
  const cancel = api.whatsapp.cancelLinkCode.useMutation();
  // Once the page shows another link, the card has done its work.
  const open = card?.linkedIdAtStart === linkedId;
  const status = api.whatsapp.linkStatus.useQuery(undefined, {
    enabled: open,
    refetchInterval: (query) => {
      if (!card) return false;
      const seen = linkPhase(query.state.data, query.state.dataUpdatedAt, card);
      return seen === "connected" || seen === "expired" ? false : 3000;
    },
    refetchOnWindowFocus: true,
  });
  const phase = card
    ? linkPhase(status.data, status.dataUpdatedAt, card)
    : "waiting";
  const connected = open && phase === "connected";

  useEffect(() => {
    if (connected) router.refresh();
  }, [connected, router]);

  // Cancel hands focus back to the button the card replaced.
  useEffect(() => {
    if (card !== null || !cancelled.current) return;
    cancelled.current = false;
    connectButton.current?.focus();
  }, [card]);

  if (!open) {
    return (
      <div className="space-y-2">
        <Button
          disabled={linkCode.isPending}
          onClick={() => {
            linkCode.mutate();
          }}
          ref={connectButton}
          size="default"
          variant={prominent ? "default" : "surface"}
        >
          {linkCode.isPending ? <Spinner /> : <MessageCircleIcon />}
          {label}
        </Button>
        {failed && (
          <p className="type-caption text-destructive" role="alert">
            That did not go through. Try again.
          </p>
        )}
      </div>
    );
  }

  return (
    <LinkCodeCard
      code={card.code}
      expiresAt={card.expiresAt}
      failed={failed}
      onCancel={() => {
        cancel.mutate();
        cancelled.current = true;
        setCard(null);
      }}
      onNewCode={() => {
        linkCode.mutate();
      }}
      pending={linkCode.isPending}
      phase={phase}
      sender={sender}
    />
  );
}

const phaseTitles = {
  connected: "Connected",
  expired: "This code expired",
  used: "This code was used",
  waiting: "Send this code on WhatsApp",
} as const satisfies Record<LinkPhase, string>;

// The code, a QR code of the wa.me link that sends it, and the same link as a
// button for someone already on their phone, which cannot scan its own
// screen. The title and the line under it are one status region, so each
// change is read out.
export function LinkCodeCard({
  code,
  expiresAt,
  failed,
  onCancel,
  onNewCode,
  pending,
  phase,
  sender,
}: {
  readonly code: string;
  readonly expiresAt: string;
  readonly failed: boolean;
  readonly onCancel: () => void;
  readonly onNewCode: () => void;
  readonly pending: boolean;
  readonly phase: LinkPhase;
  readonly sender: Sender;
}) {
  const title = useRef<HTMLSpanElement>(null);
  const link = `https://wa.me/${sender.digits}?text=${encodeURIComponent(`link ${code}`)}`;
  const until = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(expiresAt));
  const line = {
    connected: "Your number now reaches assist.",
    expired: "Codes work for 10 minutes. Get a new one to try again.",
    used: "WhatsApp's reply says what happened. To try again, get a new code.",
    waiting: `Waiting for your message. The code works until ${until}.`,
  }[phase];

  // The card takes the place of the button that opened it.
  useEffect(() => {
    title.current?.focus();
  }, []);

  return (
    <Card className="max-w-xl">
      <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center">
        {phase === "waiting" && (
          <div className="hidden shrink-0 flex-col items-center gap-2 sm:flex">
            <QrCode value={link} />
            <p
              aria-hidden="true"
              className="type-caption text-muted-foreground"
            >
              Scan with your phone
            </p>
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-4">
          <output className="block space-y-1">
            <span
              className="block type-card-title outline-none"
              ref={title}
              tabIndex={-1}
            >
              {phaseTitles[phase]}
            </span>
            <span className="type-supporting-body flex items-center gap-2 text-muted-foreground">
              {phase === "waiting" && <Spinner />}
              {line}
            </span>
          </output>
          {phase === "waiting" && (
            <>
              <Button
                className="w-full sm:w-auto"
                nativeButton={false}
                render={
                  <a
                    aria-label="Open WhatsApp"
                    href={link}
                    rel="noreferrer"
                    target="_blank"
                  />
                }
              >
                <MessageCircleIcon />
                Open WhatsApp
              </Button>
              <p className="type-supporting-body text-muted-foreground">
                Or send{" "}
                <span className="type-code whitespace-nowrap text-foreground select-all">
                  link {code}
                </span>{" "}
                to <span className="whitespace-nowrap">{sender.number}</span>
              </p>
            </>
          )}
          {failed && (
            <p className="type-caption text-destructive" role="alert">
              That did not go through. Try again.
            </p>
          )}
          {phase !== "connected" && (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending}
                onClick={onNewCode}
                size="sm"
                variant={phase === "expired" ? "default" : "ghost"}
              >
                {pending && <Spinner />}
                New code
              </Button>
              <Button onClick={onCancel} size="sm" variant="ghost">
                Cancel
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
