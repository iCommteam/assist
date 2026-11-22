import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@db/services/auth";

// The only Better Auth endpoints the sign-in pages use. Everything else,
// including social sign-in, password reset, email change, account deletion,
// session listing and disabling two-factor, answers 404 before Better Auth
// sees it. Parameterised paths such as /reset-password/:token are covered too,
// which Better Auth's exact-match disabledPaths cannot do.
const exposedEndpoints = new Map([
  ["/get-session", "GET"],
  ["/sign-in/email", "POST"],
  ["/sign-out", "POST"],
  ["/sign-up/email", "POST"],
  ["/two-factor/enable", "POST"],
  ["/two-factor/verify-backup-code", "POST"],
  ["/two-factor/verify-totp", "POST"],
]);
const authBasePath = "/api/auth";

async function loadHandlers() {
  return toNextJsHandler(await getAuth());
}

let handlersPromise: ReturnType<typeof loadHandlers> | undefined;

function getHandlers() {
  handlersPromise ??= loadHandlersWithRetry();
  return handlersPromise;
}

async function loadHandlersWithRetry() {
  try {
    return await loadHandlers();
  } catch (error) {
    handlersPromise = undefined;
    throw error;
  }
}

function isExposed(request: Request) {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${authBasePath}/`)) return false;
  return (
    exposedEndpoints.get(pathname.slice(authBasePath.length)) === request.method
  );
}

function notFound() {
  return new Response("Not Found", { status: 404 });
}

export async function GET(request: Request) {
  if (!isExposed(request)) return notFound();
  return (await getHandlers()).GET(request);
}

export async function POST(request: Request) {
  if (!isExposed(request)) return notFound();
  return (await getHandlers()).POST(request);
}
