import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  type ConnectionPrincipal,
} from "eve/connections";
import { z } from "zod";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  dropGoogleAccessToken,
  googleAccessToken,
  GoogleReconnectNeededError,
  startGoogleConnect,
} from "@db/services/connectors/google";
import {
  GoogleUnavailableError,
  isEveCallbackPath,
} from "@shared/connectors/google/oauth";

const connection = "google";

// Passed with every ctx.getToken and ctx.requireAuth: a custom provider needs
// its own key for eve's token cache and callback route.
export const googleAuthOptions = {
  authKey: connection,
  displayName: "Google",
} as const;

// The member's own Google account, as the caller of the turn. eve asks this
// before every call of a Google tool. A member whose grant Google refused, or
// who disconnected, is asked to connect again in the chat: eve opens a
// sign-in, Google redirects to assist's one registered callback
// (app/api/connectors/google/callback), which keeps the tokens and forwards
// the browser to eve's callback for this attempt, and the call runs again.
// The `resume` value eve journals is the state alone; the PKCE verifier and
// eve's callback stay sealed in the flow's row, and no token passes through
// eve's callback.
export const googleAuth = defineInteractiveAuthorization<{
  readonly state: string;
}>({
  displayName: "Google",
  getToken: ({ principal }) => tokenFor(principal),
  async startAuthorization({ callbackUrl, principal }) {
    const scope = principalScope(principal);
    const callbackPath = new URL(callbackUrl).pathname;
    if (!isEveCallbackPath(callbackPath)) {
      throw new ConnectionAuthorizationFailedError(connection, {
        message: "The sign-in could not start.",
        reason: "callback_unexpected",
        retryable: false,
      });
    }
    const flow = await startGoogleConnect(
      scope,
      { callbackPath, kind: "chat" },
      principalEmail(principal)
    );
    return {
      challenge: {
        displayName: "Google",
        expiresAt: flow.expiresAt.toISOString(),
        url: flow.url,
      },
      resume: { state: flow.state },
    };
  },
  async completeAuthorization({ callback, principal, resume }) {
    const { error, state } = callback.params;
    if (error !== undefined || !resume || state !== resume.state) {
      // Denied on Google's screen, or every ability unticked there.
      const denied = error === "denied" || error === "nothing-allowed";
      throw new ConnectionAuthorizationFailedError(connection, {
        message: denied
          ? "Google access was not granted."
          : "The Google sign-in did not complete.",
        reason: denied ? "access_denied" : "sign_in_failed",
        retryable: false,
      });
    }
    return tokenFor(principal);
  },
  // eve calls this when Google rejected a token it handed out, so the next
  // call refreshes instead of reusing it.
  async evict({ principal }) {
    try {
      await dropGoogleAccessToken(principalScope(principal));
    } catch {
      // Best effort: eve's own cache is already cleared.
    }
  },
});

async function tokenFor(principal: ConnectionPrincipal) {
  const scope = principalScope(principal);
  try {
    return await googleAccessToken(scope);
  } catch (error) {
    if (error instanceof GoogleReconnectNeededError) {
      throw new ConnectionAuthorizationRequiredError(connection, {
        message: "Connect Google again to continue.",
      });
    }
    if (error instanceof GoogleUnavailableError) {
      throw new ConnectionAuthorizationFailedError(connection, {
        message: "Google could not be reached. Try again in a moment.",
        reason: "google_unavailable",
      });
    }
    throw error;
  }
}

// Each member's tokens are read under the workspace their own principal
// names, so a turn can only ever use its caller's account.
function principalScope(principal: ConnectionPrincipal) {
  if (principal.type !== "user") {
    throw new ConnectionAuthorizationFailedError(connection, {
      reason: "principal_required",
      retryable: false,
    });
  }
  return scopeFromPrincipal(principal);
}

function principalEmail(principal: ConnectionPrincipal) {
  if (principal.type !== "user") return undefined;
  const email = z.email().safeParse(principal.attributes?.email);
  return email.success ? email.data : undefined;
}
