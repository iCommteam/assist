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
