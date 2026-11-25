import { getAuthSession } from "@db/services/auth/session";
import { startGoogleConnect } from "@db/services/connectors/google";
import { googleOAuthClient } from "@shared/connectors/google/oauth";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { privateJson } from "@app/api/connectors/google/_lib/respond";

// The Workspace page's Connect Google button. It starts a connect for the
// signed-in member and answers Google's consent URL, which the page opens.
// The page calls it with fetch, never a form: the app sends no Referer, so a
// form's POST carries Origin: null, which the proxy refuses, as it refuses
// every other origin.
export async function POST(request: Request) {
  const session = await getAuthSession(request.headers);
  if (!session) return privateJson({ error: "unauthenticated" }, 401);
  if (!googleOAuthClient()) return privateJson({ error: "unavailable" }, 409);
  const flow = await startGoogleConnect(
    accessScopeForUser(`better-auth:${session.user.id}`),
    { kind: "settings" },
    session.user.email
  );
  return privateJson({ url: flow.url }, 200);
}
