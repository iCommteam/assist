import type { SessionContext } from "eve/context";
import { recordSiteTaskSignInOrigin } from "@db/services/sites";
import { siteLoginOfSession, siteOfSession } from "@agent/lib/site-principal";
import {
  isOnLoginSite,
  siteNavigationFence,
} from "@agent/subagents/browser-agent/lib/policy/hosts";
import type { AccessScope } from "@shared/identity/access-scope";

export const signInElsewhereMessage =
  'This page is on the pinned login\'s site but not on the exact origin the login was saved with, so nothing was filled. The password and codes are filled only on that origin: never type them yourself. Delete the browser, then return status "failure" saying the website asks for the password on a different page of the same site than the saved one, so the task ends as sign_in_elsewhere.';

// A pinned login is filled only on the exact origin it was saved with, and
// that stays so. When a fill is refused on another https page of the login's
// own site, under its registrable domain or on a host it also uses but never
// on Stripe's, that page's origin is recorded for the task: the site then
// learns where the website asks for the password from the browser, never
// from a model. Says whether it was recorded; a failed write only leaves the
// refusal as it was.
export async function recordSignInElsewhere(
  session: Pick<SessionContext["session"], "auth" | "parent">,
  scope: AccessScope,
  pageOrigin: string
) {
  const { initiator } = session.auth;
  const site = siteOfSession(initiator);
  const login = siteLoginOfSession(initiator);
  // The worker's root session is the site task's session.
  const taskSessionId = session.parent?.rootSessionId;
  if (!site || !login || !taskSessionId || pageOrigin === login.origin) {
    return false;
  }
  if (!URL.canParse(pageOrigin)) return false;
  const page = new URL(pageOrigin);
  // No site saves a login on a port, so a page on one is never recorded.
  if (
    page.protocol !== "https:" ||
    page.port !== "" ||
    page.origin !== pageOrigin ||
    !isOnLoginSite(
      page.hostname,
      siteNavigationFence(login.origin, login.alsoHosts)
    )
  ) {
    return false;
  }
  try {
    return await recordSiteTaskSignInOrigin(
      site,
      scope,
      taskSessionId,
      pageOrigin
    );
  } catch (error) {
    console.warn("[site] task sign-in page not recorded", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return false;
  }
}
