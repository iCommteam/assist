"use client";

import { MessageCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { QrCode } from "@app/_components/qr-code";
import { Button } from "@web/components/ui/button";
import { Card, CardContent } from "@web/components/ui/card";
import { Spinner } from "@web/components/ui/spinner";
import { api } from "@web/trpc/client";

// The company's WhatsApp number, as wa.me wants it and as people read it.
interface Sender {
  readonly digits: string;
  readonly number: string;
}

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
      const seen = query.state.data;
      return seen && (!seen.codeLive || seen.linkedId !== linkedId)
        ? false
        : 3000;
    },
    refetchOnWindowFocus: true,
  });
  const landed =
    open &&
    status.data?.linkedId !== undefined &&
    status.data.linkedId !== null &&
    status.data.linkedId !== linkedId;
  const expired = open && !landed && status.data?.codeLive === false;

  useEffect(() => {
    if (landed) router.refresh();
  }, [landed, router]);

  if (!open || landed) {
    return (
      <div className="space-y-2">
        <Button
          disabled={linkCode.isPending || landed}
          onClick={() => {
            linkCode.mutate();
          }}
          size="default"
          variant={prominent ? "default" : "surface"}
        >
          {linkCode.isPending || landed ? <Spinner /> : <MessageCircleIcon />}
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
      expired={expired}
      expiresAt={card.expiresAt}
      failed={failed}
      onCancel={() => {
        cancel.mutate();
        setCard(null);
      }}
      onNewCode={() => {
        linkCode.mutate();
      }}
      pending={linkCode.isPending}
      sender={sender}
    />
  );
}

// The code, a QR code of the wa.me link that sends it, and the same link as a
// button for someone already on their phone, which cannot scan its own
// screen.
export function LinkCodeCard({
  code,
  expired,
  expiresAt,
  failed,
  onCancel,
  onNewCode,
  pending,
  sender,
}: {
  readonly code: string;
  readonly expired: boolean;
  readonly expiresAt: string;
  readonly failed: boolean;
  readonly onCancel: () => void;
  readonly onNewCode: () => void;
  readonly pending: boolean;
  readonly sender: Sender;
}) {
  const link = `https://wa.me/${sender.digits}?text=${encodeURIComponent(`link ${code}`)}`;
  const until = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(expiresAt));

  return (
    <Card className="max-w-xl">
      <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center">
        {!expired && (
          <div className="hidden shrink-0 flex-col items-center gap-2 sm:flex">
            <QrCode value={link} />
            <p className="type-caption text-muted-foreground">
              Scan with your phone
            </p>
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-4">
          <p className="type-card-title">
            {expired ? "This code expired" : "Send this code on WhatsApp"}
          </p>
          {expired ? (
            <p className="type-supporting-body text-muted-foreground">
              Codes work for 10 minutes. Get a new one to try again.
            </p>
          ) : (
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
              <p className="flex items-center gap-2 type-caption text-muted-foreground">
                <Spinner />
                Waiting for your message. The code works until {until}.
              </p>
            </>
          )}
          {failed && (
            <p className="type-caption text-destructive" role="alert">
              That did not go through. Try again.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending}
              onClick={onNewCode}
              size="sm"
              variant={expired ? "default" : "ghost"}
            >
              {pending && <Spinner />}
              New code
            </Button>
            <Button onClick={onCancel} size="sm" variant="ghost">
              Cancel
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
