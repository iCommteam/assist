import Kernel, { NotFoundError } from "@onkernel/sdk";
import { readBrowserSession } from "@db/services/browsers";
import { env } from "@shared/environment";
import {
  requireRequestScope,
  UnauthenticatedError,
} from "@web/auth/request-scope";

// The browser handoff. Kernel's live-view URL controls a possibly logged-in
// browser, so the worker and the chat only ever carry this route's link. It
// fetches a fresh live-view URL for a browser the signed-in member's workspace
// owns and redirects to it; nothing is cached and no Referer leaves.
//
// The app layer may not import agent code, so this route keeps its own Kernel
// client; the worker tools share theirs through
// agent/subagents/browser-agent/lib/kernel.ts.
const kernel = new Kernel({ apiKey: env.KERNEL_API_KEY });

const privateHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

export async function GET(
  _request: Request,
  context: RouteContext<"/browsers/[id]/live">
) {
  let scope: Awaited<ReturnType<typeof requireRequestScope>>;
  try {
    scope = await requireRequestScope();
  } catch (error) {
    if (!(error instanceof UnauthenticatedError)) throw error;
    return plainResponse(401, "Sign in to continue.");
  }

  const { id } = await context.params;
  if (!(await readBrowserSession(scope, id))) return unavailable();

  try {
    const browser = await kernel.browsers.retrieve(
      id,
      {},
      { signal: AbortSignal.timeout(10_000) }
    );
    if (browser.deleted_at || !browser.browser_live_view_url) {
      return unavailable();
    }
    return new Response(null, {
      headers: { ...privateHeaders, Location: browser.browser_live_view_url },
      status: 303,
    });
  } catch (error) {
    if (error instanceof NotFoundError) return unavailable();
    throw error;
  }
}

function unavailable() {
  return plainResponse(404, "This browser is no longer available.");
}

function plainResponse(status: number, message: string) {
  return new Response(message, {
    headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" },
    status,
  });
}
