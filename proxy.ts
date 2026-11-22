import { NextResponse, type NextRequest } from "next/server";
import { getAuthSession } from "@db/services/auth/session";

// Pages and endpoints reachable without a completed sign-in. The setup page
// checks its own password-only session; Better Auth checks its endpoints.
const publicPaths = new Set([
  "/sign-in",
  "/sign-up",
  "/two-factor",
  "/eve/v1/health",
]);

// The site API authenticates each call by bearer token and never reads
// cookies, so it skips the sign-in redirect. Only its exact routes match.
const siteApiPath = /^\/api\/site\/(?:ping|tasks|tasks\/[^/]+)$/u;

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    publicPaths.has(pathname) ||
    siteApiPath.test(pathname) ||
    pathname.startsWith("/api/auth/")
  ) {
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
    "/((?!_next/static|_next/image|fonts|favicon.ico|icon\\.svg$|apple-icon\\.png$|opengraph-image\\.png$).*)",
  ],
};
