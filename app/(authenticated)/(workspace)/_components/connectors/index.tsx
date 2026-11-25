import { CheckIcon, MinusIcon, PlugIcon } from "lucide-react";
import { Suspense } from "react";
import { googleAccountOf } from "@db/services/connectors/google";
import { googleOAuthClient } from "@shared/connectors/google/oauth";
import { googleAbilities } from "@shared/connectors/google/scopes";
import { Badge } from "@web/components/ui/badge";
import { requireRequestScope } from "@web/auth/request-scope";
import { GoogleConnect } from "./connect";
import { GoogleDisconnect } from "./disconnect";
import { ConnectorOutcome } from "./outcome";

// The Workspace page's Connectors: each member connects their own accounts
// here, and only they can use them, in their own chats.
export async function ConnectorsSection() {
  const scope = await requireRequestScope();
  const configured = googleOAuthClient() !== undefined;
  const account = configured ? await googleAccountOf(scope) : undefined;

  return (
    <section
      aria-labelledby="account-connectors-heading"
      className="scroll-mt-6 space-y-3"
      id="connectors"
    >
      <h2 className="type-section-title" id="account-connectors-heading">
        Connectors
      </h2>
      <Suspense fallback={null}>
        <ConnectorOutcome />
      </Suspense>
      <div className="border-y border-border/50">
        <div className="flex flex-wrap items-center gap-3 py-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground">
            <PlugIcon />
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 type-label">
              Google Workspace
              {account ? (
                account.needsReconnect ? (
                  <Badge variant="warning">Reconnect needed</Badge>
                ) : (
                  <Badge variant="success">Connected</Badge>
                )
              ) : null}
            </p>
            <p className="truncate type-caption text-muted-foreground">
              {!configured
                ? "An administrator has not set up Google for assist yet."
                : account
                  ? account.email
                  : "Gmail, Calendar and Drive, for your own chats."}
            </p>
          </div>
          {configured ? (
            <div className="flex shrink-0 items-start gap-2">
              {!account || account.needsReconnect ? (
                <GoogleConnect
                  label={account ? "Reconnect" : "Connect Google"}
                />
              ) : null}
              {account ? <GoogleDisconnect email={account.email} /> : null}
            </div>
          ) : (
            <Badge variant="outline">Not set up</Badge>
          )}
        </div>
        {account ? <GoogleAbilities scopes={account.scopes} /> : null}
      </div>
    </section>
  );
}

// What the connected account lets assist do, as Google granted it. An
// ability the member unticked on Google's consent screen shows as missing.
function GoogleAbilities({ scopes }: { readonly scopes: readonly string[] }) {
  const granted = new Set(scopes);
  const missing = googleAbilities.some(
    (ability) => !granted.has(ability.scope)
  );
  return (
    <div className="space-y-2 pb-4 pl-12">
      <ul className="grid gap-1 sm:grid-cols-2" aria-label="What assist may do">
        {googleAbilities.map((ability) => {
          const allowed = granted.has(ability.scope);
          const Icon = allowed ? CheckIcon : MinusIcon;
          return (
            <li
              className={`flex items-start gap-2 type-caption ${allowed ? "text-foreground" : "text-muted-foreground"}`}
              key={ability.id}
            >
              <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <span className="sr-only">
                  {allowed ? "Allowed: " : "Not allowed: "}
                </span>
                {ability.service} · {ability.label}
              </span>
            </li>
          );
        })}
      </ul>
      {missing ? (
        <p className="type-caption text-muted-foreground">
          To allow what is missing, disconnect and connect again, and tick it on
          Google&apos;s screen.
        </p>
      ) : null}
    </div>
  );
}
