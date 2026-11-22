import type { ConnectionPrincipal } from "eve/connections";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { accessScopeForUser } from "@shared/identity/access-scope";

// Every principal this app issues names a Better Auth user: a signed-in
// member, a scheduled run acting for one, or a connected site acting for its
// owner. The workspace is always derived from that user, never taken from the
// caller; the attribute must merely agree with it.
const userPrincipalPrefix = "better-auth:";

const principalScopeSchema = z.object({
  attributes: z.object({
    workspaceId: z.string().min(1),
  }),
  id: z.string().min(1).optional(),
  principalId: z.string().min(1).optional(),
});

export function scopeFromPrincipal(
  input: SessionAuthContext | Extract<ConnectionPrincipal, { type: "user" }>
) {
  const principal = principalScopeSchema.parse(input);
  const userId = principal.id ?? principal.principalId;
  if (
    !userId?.startsWith(userPrincipalPrefix) ||
    userId.slice(userPrincipalPrefix.length).trim().length === 0
  ) {
    throw new Error("An authenticated workspace user is required.");
  }
  const scope = accessScopeForUser(userId);
  if (scope.workspaceId !== principal.attributes.workspaceId) {
    throw new Error("The workspace does not belong to the authenticated user.");
  }
  return scope;
}
