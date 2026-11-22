import { CloudIcon, MailIcon, MessageSquareIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import { env } from "@shared/environment";
import { requireRequestScope } from "@web/auth/request-scope";

export default async function Page() {
  await requireRequestScope();
  const browserReady = true;

  return (
    <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="sr-only">Workspace</h1>

      <ChannelsSection
        browserReady={browserReady}
        linqConfigured={env.LINQ_CONNECTOR !== undefined}
        linqPhoneNumber={env.LINQ_PHONE_NUMBER}
      />

      <WorkspaceSection headingId="connectors-heading" title="Infrastructure">
        <div className="divide-y divide-border/50 border-y border-border/50">
          <ConnectorRow
            action={<Badge variant="success">Connected</Badge>}
            description="Run isolated browsers in your Kernel account."
            icon={<CloudIcon />}
            label="Kernel browser"
          />
        </div>
      </WorkspaceSection>
    </div>
  );
}

export function ChannelsSection({
  browserReady,
  linqConfigured,
  linqPhoneNumber,
}: {
  readonly browserReady: boolean;
  readonly linqConfigured: boolean;
  readonly linqPhoneNumber?: string;
}) {
  return (
    <WorkspaceSection headingId="channels-heading" title="Channels">
      <div className="grid gap-2 sm:grid-cols-2">
        {browserReady ? (
          <Button
            nativeButton={false}
            render={<Link href="/chat" />}
            variant="surface"
          >
            <MessageSquareIcon />
            WebChat
          </Button>
        ) : (
          <Button disabled variant="surface">
            <MessageSquareIcon />
            WebChat
          </Button>
        )}
        {linqConfigured && linqPhoneNumber ? (
          <Button
            nativeButton={false}
            render={
              <a aria-label="Open iMessage" href={`sms:${linqPhoneNumber}`} />
            }
            variant="surface"
          >
            <MailIcon />
            iMessage
          </Button>
        ) : (
          <Button disabled variant="surface">
            <MailIcon />
            iMessage
          </Button>
        )}
      </div>
      <p className="type-caption text-muted-foreground">
        {channelAvailabilityMessage({
          browserReady,
          linqConfigured,
          linqPhoneNumber,
        })}
      </p>
    </WorkspaceSection>
  );
}

function channelAvailabilityMessage({
  browserReady,
  linqConfigured,
  linqPhoneNumber,
}: {
  readonly browserReady: boolean;
  readonly linqConfigured: boolean;
  readonly linqPhoneNumber?: string;
}) {
  return [
    browserReady
      ? "WebChat is ready."
      : "KERNEL_API_KEY is required to enable WebChat.",
    linqConfigured && linqPhoneNumber
      ? `iMessage opens ${linqPhoneNumber}.`
      : linqConfigured
        ? "Linq is connected. Use its assigned line to start an iMessage."
        : "Set up Linq to enable iMessage.",
  ].join(" ");
}

function WorkspaceSection({
  children,
  headingId,
  title,
}: {
  readonly children: ReactNode;
  readonly headingId: string;
  readonly title: string;
}) {
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 className="type-section-title" id={headingId}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ConnectorRow({
  action,
  description,
  icon,
  label,
}: {
  readonly action: ReactNode;
  readonly description: string;
  readonly icon: ReactNode;
  readonly label: string;
}) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="type-label">{label}</p>
        <p className="truncate type-caption text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}
