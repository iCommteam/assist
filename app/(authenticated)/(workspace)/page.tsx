import { CloudIcon, MessageSquareIcon } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { WhatsappAccess } from "./_components/whatsapp-access";
import { isAdminMember } from "@db/services/auth/allowlist";
import { getAuthSession } from "@db/services/auth/session";
import { whatsappLockOf } from "@db/services/whatsapp";
import { env } from "@shared/environment";
import { numbersOfMember } from "@shared/environment/whatsapp";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import { requireRequestScope } from "@web/auth/request-scope";

export default async function Page() {
  await requireRequestScope();
  const browserReady = true;
  const whatsapp = await whatsappSection();

  return (
    <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="sr-only">Workspace</h1>

      <ChannelsSection browserReady={browserReady} />

      {whatsapp && (
        <WorkspaceSection headingId="whatsapp-heading" title="WhatsApp">
          <WhatsappAccess {...whatsapp} />
        </WorkspaceSection>
      )}

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

// Shown while the WhatsApp channel is configured, to a member whose number
// is listed and to an administrator.
async function whatsappSection() {
  if (
    env.TWILIO_ACCOUNT_SID === undefined ||
    env.TWILIO_AUTH_TOKEN === undefined ||
    env.TWILIO_WHATSAPP_FROM === undefined
  ) {
    return undefined;
  }
  const session = await getAuthSession(await headers());
  if (!session) return undefined;
  const numbers = numbersOfMember(session.user.email);
  const admin = await isAdminMember(session.user.id);
  if (numbers.length === 0 && !admin) return undefined;
  const lock = await whatsappLockOf(session.user.id);
  return {
    admin,
    lockedEveryone: lock.everyone,
    lockedSelf: lock.self,
    numbers,
  };
}

function ChannelsSection({ browserReady }: { readonly browserReady: boolean }) {
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
      </div>
      <p className="type-caption text-muted-foreground">
        {browserReady
          ? "WebChat is ready."
          : "KERNEL_API_KEY is required to enable WebChat."}
      </p>
    </WorkspaceSection>
  );
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
