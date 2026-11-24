import { NextResponse, type NextRequest } from "next/server";
import { getAuthSession } from "@db/services/auth/session";
import { isSameOrigin } from "@web/trpc/same-origin";

// Pages and endpoints reachable without a completed sign-in. The setup page
// checks its own password-only session; Better Auth checks its endpoints.
const publicPaths = new Set([
  "/sign-in",
  "/sign-up",
  "/two-factor",
  "/eve/v1/health",
]);

// The site API authenticates each call by bearer token and never reads
// cookies, so it skips the sign-in redirect and the Origin check. Only its
// exact routes match.
const siteApiPath =
  /^\/api\/site\/(?:ping|logins(?:\/[^/]+)?|tasks(?:\/[^/]+(?:\/(?:input|cancel|files(?:\/[^/]+)?))?)?|chats(?:\/[^/]+\/(?:messages|answers|token|stream|cancel))?)$/u;

const safeMethods = new Set(["GET", "HEAD"]);

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (siteApiPath.test(pathname)) return NextResponse.next();

  // Cross-site request forgery: a sibling *.icommteam.com site is same-site,
  // so SameSite cookies alone do not stop it from posting here (eve's session
  // endpoint accepts a text/plain body). Better Auth checks the Origin of its
  // own endpoints.
  if (
    !safeMethods.has(request.method) &&
    !pathname.startsWith("/api/auth/") &&
    !isSameOrigin(request)
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (publicPaths.has(pathname) || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  if (await getAuthSession(request.headers)) return NextResponse.next();

  const signInUrl = new URL("/sign-in", request.url);
  signInUrl.searchParams.set(
    "callbackUrl",
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|fonts|icon\\.svg$|apple-icon\\.png$|opengraph-image\\.png$).*)",
  ],
};
