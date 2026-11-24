import type { SessionContext } from "eve/context";
import {
  clearSiteTaskSignInOrigin,
  recordSiteTaskSignInOrigin,
} from "@db/services/sites";
import { siteLoginOfSession, siteOfSession } from "@agent/lib/site-principal";
import {
  isOnLoginSite,
  siteNavigationFence,
} from "@agent/subagents/browser-agent/lib/policy/hosts";
import { isIdentityProviderHost } from "@shared/browser/hosts";
import type { AccessScope } from "@shared/identity/access-scope";

type WorkerSession = Pick<SessionContext["session"], "auth" | "parent">;

// The refusal of a fill on another page of the pinned login's own site. The
// worker may only have opened the wrong page, so it is sent to the saved
// origin first, and ends the task only when the website keeps it away.
export class SignInElsewhereRefusal extends Error {
  constructor(loginOrigin: string) {
    super(
      `This page is on the pinned login's site but not on ${loginOrigin}, the exact origin the login was saved with, so nothing was filled. The password and codes are filled only on that origin: never type them yourself. Open ${loginOrigin} with browser_navigate and sign in there. If it shows no sign-in form, or you already did and the website led you back from it to a page like this one, delete the browser, then return status "failure" saying the website asks for the password on a different page of the same site than the saved one, so the task ends as sign_in_elsewhere.`
    );
  }
}

// A pinned login is filled only on the exact origin it was saved with, and
// that stays so. When a fill is refused on another https page of the login's
// own site, under its registrable domain or on a host it also uses but never
// on Stripe's, that page's origin is recorded for the task: the site then
// learns where the website asks for the password from the browser, never
// from a model. Only a page the site could save a login on is recorded; a
// refusal on any other page of the login's site, such as an identity
// provider under its domain, forgets the page recorded before, as the
// sign-in has moved on from it. A page off the site says nothing of where it
// signs in. Says whether it was recorded; a failed write only leaves the
// refusal as it was.
export async function recordSignInElsewhere(
  session: WorkerSession,
  scope: AccessScope,
  pageOrigin: string
) {
  const task = pinnedSiteTask(session);
  if (!task || pageOrigin === task.login.origin || !URL.canParse(pageOrigin)) {
    return false;
  }
  const page = new URL(pageOrigin);
  const { alsoHosts, origin } = task.login;
  if (!isOnLoginSite(page.hostname, siteNavigationFence(origin, alsoHosts))) {
    return false;
  }
  try {
    if (!isSaveableOrigin(page, pageOrigin)) {
      await clearSiteTaskSignInOrigin(task.site, scope, task.sessionId);
      return false;
    }
    return await recordSiteTaskSignInOrigin(
      task.site,
      scope,
      task.sessionId,
      pageOrigin
    );
  } catch (error) {
    console.warn("[site] task sign-in page not recorded", {
      error: error instanceof Error ? error.name : "unknown",
      site: task.site,
    });
    return false;
  }
}

// After a fill on the saved origin, the page recorded before is not where
// the website asks for the password, so the task no longer reports it. A
// failed write only leaves that page recorded.
export async function forgetSignInElsewhere(
  session: WorkerSession,
  scope: AccessScope
) {
  const task = pinnedSiteTask(session);
  if (!task) return;
  try {
    await clearSiteTaskSignInOrigin(task.site, scope, task.sessionId);
  } catch (error) {
    console.warn("[site] task sign-in page not cleared", {
      error: error instanceof Error ? error.name : "unknown",
      site: task.site,
    });
  }
}

function pinnedSiteTask(session: WorkerSession) {
  const { initiator } = session.auth;
  const site = siteOfSession(initiator);
  const login = siteLoginOfSession(initiator);
  // The worker's root session is the site task's session.
  const sessionId = session.parent?.rootSessionId;
  return site && login && sessionId ? { login, sessionId, site } : undefined;
}

// An origin POST /api/site/logins would take: https on a named host, with no
// port or trailing dot, and never an identity provider, even one under the
// login's own registrable domain, such as login.microsoft.com for a login on
// billing.microsoft.com.
function isSaveableOrigin(page: URL, pageOrigin: string) {
  return (
    page.protocol === "https:" &&
    page.port === "" &&
    page.origin === pageOrigin &&
    !page.hostname.endsWith(".") &&
    !isIdentityProviderHost(page.hostname)
  );
}
