import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import { siteLoginOfSession, siteOfSession } from "@agent/lib/site-principal";
import { readVaultItems } from "@db/services/vault";

export default defineTool({
  description:
    "List safe metadata and opaque handles for saved logins. Check this before treating a sign-in form as missing credentials. Only saved logins can be filled; never returns secret values.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const scope = await requireWorkerScope(ctx);
    // A site task sees only the login it is pinned to, and none without a pin.
    const { initiator } = ctx.session.auth;
    const pin = siteLoginOfSession(initiator);
    if (siteOfSession(initiator) && !pin) return [];
    const items = await readVaultItems(scope);
    return items
      .filter(({ id, kind }) => kind === "login" && (!pin || id === pin.id))
      .map(({ account, hasSecret, id, kind, label }) => ({
        account,
        available: hasSecret,
        handle: id,
        kind,
        label,
      }));
  },
});
