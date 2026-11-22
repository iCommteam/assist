import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import { readVaultItems } from "@db/services/vault";

export default defineTool({
  description:
    "List safe metadata and opaque handles for saved logins. Check this before treating a sign-in form as missing credentials. Only saved logins can be filled; never returns secret values.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const items = await readVaultItems(await requireWorkerScope(ctx));
    return items
      .filter(({ kind }) => kind === "login")
      .map(({ account, hasSecret, id, kind, label }) => ({
        account,
        available: hasSecret,
        handle: id,
        kind,
        label,
      }));
  },
});
