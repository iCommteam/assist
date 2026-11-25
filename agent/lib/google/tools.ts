import type { DynamicContext } from "eve";
import type { DynamicToolEntry, DynamicToolSet } from "eve/tools";
import { googleScopeOfSession } from "@agent/lib/google/offer";
import { googleAccountOf } from "@db/services/connectors/google";
import {
  grantedGoogleAbilities,
  type GoogleAbility,
} from "@shared/connectors/google/scopes";

// The Google tools a session is offered: none unless Google is set up, the
// session may use the caller's account (agent/lib/google/offer.ts) and the
// caller connected one; then each tool whose scope Google granted. An account
// whose grant Google refused keeps its tools, so the next call asks the
// member to connect again in the chat. Only the account's address and scopes
// are read here, never a token.
export async function googleToolsFor(
  context: DynamicContext,
  entries: Readonly<
    Record<
      string,
      { readonly ability: GoogleAbility; readonly tool: DynamicToolEntry }
    >
  >
): Promise<DynamicToolSet | null> {
  const scope = googleScopeOfSession(context);
  if (!scope) return null;
  let account: Awaited<ReturnType<typeof googleAccountOf>>;
  try {
    account = await googleAccountOf(scope);
  } catch {
    console.warn("[google] the connected account could not be read");
    return null;
  }
  if (!account) return null;
  const granted = new Set(grantedGoogleAbilities(account.scopes));
  const offered = Object.entries(entries).flatMap(([name, entry]) =>
    granted.has(entry.ability) ? [[name, entry.tool] as const] : []
  );
  return offered.length > 0 ? Object.fromEntries(offered) : null;
}
