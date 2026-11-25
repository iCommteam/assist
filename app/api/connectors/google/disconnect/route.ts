import { getAuthSession } from "@db/services/auth/session";
import { disconnectGoogle } from "@db/services/connectors/google";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { privateJson } from "@app/api/connectors/google/_lib/respond";

// The Workspace page's Disconnect, called with fetch like Connect. Google is
// told to revoke the grant, and assist deletes the account and its tokens
// whatever Google answers; the outcome says when Google could not confirm
// the revoke.
export async function POST(request: Request) {
  const session = await getAuthSession(request.headers);
  if (!session) return privateJson({ error: "unauthenticated" }, 401);
  const result = await disconnectGoogle(
    accessScopeForUser(`better-auth:${session.user.id}`)
  );
  return privateJson(
    {
      outcome:
        result === undefined || result.revoked ? "disconnected" : "unrevoked",
    },
    200
  );
}
