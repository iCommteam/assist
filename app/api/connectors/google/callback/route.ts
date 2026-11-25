import { getAuthSession } from "@db/services/auth/session";
import { finishGoogleConnect } from "@db/services/connectors/google";
import { isEveCallbackPath } from "@shared/connectors/google/oauth";
import { applicationOrigin } from "@shared/environment/origin";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  connectorsPage,
  seeOther,
} from "@app/api/connectors/google/_lib/respond";

// The one redirect URI registered on the Google OAuth client
// (https://assist.icommteam.com/api/connectors/google/callback). It finishes
// the signed-in member's own connect, whichever place started it: the
// tokens are kept here, sealed, and never travel further. A connect started
// from the Workspace page returns there. One started by a chat's sign-in
// continues at eve's callback for that attempt, on this origin, with the
// state alone, and eve resumes the turn that asked.
export async function GET(request: Request) {
  const session = await getAuthSession(request.headers);
  if (!session) return new Response("Sign in to continue.", { status: 401 });
  const scope = accessScopeForUser(`better-auth:${session.user.id}`);
  const params = new URL(request.url).searchParams;
  const state = params.get("state") ?? undefined;
  const result = await finishGoogleConnect(scope, {
    code: params.get("code") ?? undefined,
    error: params.get("error") ?? undefined,
    state,
  });
  const returnTo = "returnTo" in result ? result.returnTo : undefined;
  if (
    returnTo?.kind === "chat" &&
    state !== undefined &&
    isEveCallbackPath(returnTo.callbackPath)
  ) {
    const url = new URL(returnTo.callbackPath, applicationOrigin());
    url.searchParams.set("state", state);
    if (!result.ok) url.searchParams.set("error", result.reason);
    return seeOther(url.toString());
  }
  if (!result.ok) return connectorsPage(result.reason);
  // A grant that left something out says so, and the page marks what.
  return connectorsPage(result.missing.length > 0 ? "partial" : "connected");
}
