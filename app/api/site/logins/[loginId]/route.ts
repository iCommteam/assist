import { z } from "zod";
import { deleteSiteLogin } from "@db/services/vault";
import { deleteLoginProfile } from "@web/browser/login-profile";
import {
  authenticateSiteRequest,
  siteError,
  siteNoContent,
} from "@app/api/site/_lib/site-auth";
import { openTaskOfLogin } from "@app/api/site/_lib/task";

// A site removes only a login it saved itself, never while one of its tasks
// still uses it; the login's own browser profile goes with it.
export async function DELETE(
  request: Request,
  context: RouteContext<"/api/site/logins/[loginId]">
) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  const { loginId } = await context.params;
  if (!z.uuid().safeParse(loginId).success) {
    return siteError(404, "not_found");
  }
  const { owner, site } = caller;
  const open = await openTaskOfLogin(site, owner.scope, loginId);
  if (!open.ok) return open.response;
  if (open.taskId) return siteError(409, "login_busy");

  let removed: boolean;
  try {
    removed = await deleteSiteLogin(owner.scope, site, loginId);
  } catch (error) {
    console.warn("[site] login could not be deleted", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return siteError(503, "unavailable");
  }
  if (!removed) return siteError(404, "not_found");
  await deleteLoginProfile(owner.scope, loginId);
  return siteNoContent();
}
