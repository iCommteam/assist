import Kernel, { NotFoundError } from "@onkernel/sdk";
import { kernelProfileNameForLogin } from "@shared/browser/kernel-profile";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";

// The web layer may not import agent code, so it keeps its own Kernel client,
// as the browser handoff route does.
const kernel = new Kernel({ apiKey: env.KERNEL_API_KEY });

// A site task pinned to a login kept that login's sign-in in a Kernel profile
// of its own, which would outlive the login. A Kernel failure never fails the
// removal: it leaves that profile behind and is logged by error name only.
export async function deleteLoginProfile(scope: AccessScope, loginId: string) {
  try {
    await kernel.profiles.delete(
      kernelProfileNameForLogin(scope.workspaceId, loginId),
      { signal: AbortSignal.timeout(10_000) }
    );
  } catch (error) {
    if (error instanceof NotFoundError) return;
    console.warn("[vault] login browser profile could not be deleted", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// Called only while none of the login's tasks is open. A browser still saving
// to the login's profile was then left by a task that ended, such as one
// cancelled while it waited for a code, and would refuse the next task's
// sign-in until it idles out; the new task wins, also over a later chat turn
// of an old task. A Kernel failure never fails the start.
export async function closeLeftLoginWriters(
  scope: AccessScope,
  loginId: string
) {
  const signal = AbortSignal.timeout(15_000);
  try {
    const profile = await kernel.profiles.retrieve(
      kernelProfileNameForLogin(scope.workspaceId, loginId),
      { signal }
    );
    const writers: string[] = [];
    for await (const browser of kernel.browsers.list(
      { query: profile.id, status: "active" },
      { signal }
    )) {
      if (browser.profile?.id === profile.id && browser.profile_save_changes) {
        writers.push(browser.session_id);
      }
    }
    await Promise.all(
      writers.map(async (sessionId) => {
        try {
          await kernel.browsers.deleteByID(sessionId, { signal });
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      })
    );
    if (writers.length > 0) {
      console.info("[site] closed a sign-in browser a finished task left", {
        browsers: writers.length,
      });
    }
  } catch (error) {
    if (error instanceof NotFoundError) return;
    console.warn("[site] login sign-in browsers could not be checked", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}
