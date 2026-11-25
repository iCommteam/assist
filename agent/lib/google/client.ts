import { auth } from "@googleapis/gmail";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { googleAuth, googleAuthOptions } from "@agent/lib/google/auth";
import { markGoogleUsed } from "@agent/lib/google/browser-gate";
import { redactSecrets } from "@agent/lib/google/content";

type GoogleAuthClient = InstanceType<typeof auth.OAuth2>;

// Runs one Google call with the caller's own access token. A failure reaches
// the model as a plain error with the status and Google's reason: the
// client's own error carries the request, Authorization header included, so
// it never leaves here. A token Google rejected asks the member to connect
// again. Every call first marks the session, so its browser tasks ask the
// member from then on (agent/lib/google/browser-gate.ts).
export async function withGoogle<T>(
  ctx: ToolContext,
  service: string,
  call: (client: GoogleAuthClient) => Promise<T>
) {
  const { token } = await ctx.getToken(googleAuth, googleAuthOptions);
  markGoogleUsed();
  const client = new auth.OAuth2();
  client.setCredentials({ access_token: token });
  let failure: ReturnType<typeof googleFailure>;
  try {
    return await call(client);
  } catch (error) {
    failure = googleFailure(error);
  }
  if (ctx.abortSignal.aborted) throw new Error(`${service} call cancelled.`);
  if (failure.status === 401) ctx.requireAuth(googleAuth, googleAuthOptions);
  throw new Error(failureMessage(service, failure));
}

const apiErrorSchema = z.object({
  response: z.object({
    data: z
      .object({
        error: z
          .object({
            message: z.string().optional(),
            status: z.string().optional(),
          })
          .optional(),
      })
      .optional()
      .catch(undefined),
    status: z.number(),
  }),
});

export function googleApiStatus(cause: unknown) {
  return googleFailure(cause).status;
}

function googleFailure(cause: unknown) {
  const parsed = apiErrorSchema.safeParse(cause);
  if (!parsed.success) return { message: undefined, status: undefined };
  return {
    message: parsed.data.response.data?.error?.message,
    status: parsed.data.response.status,
  };
}

function failureMessage(
  service: string,
  failure: ReturnType<typeof googleFailure>
) {
  if (failure.status === undefined) {
    return `${service} could not be reached. Try again in a moment.`;
  }
  if (
    failure.status === 403 &&
    /scope|permission/iu.test(failure.message ?? "")
  ) {
    return `${service} refused: the connected Google account did not grant this permission. The member can reconnect Google on assist's Workspace page and allow it.`;
  }
  const reason = failure.message
    ? `: ${redactSecrets(failure.message).slice(0, 300)}`
    : "";
  return `${service} answered ${String(failure.status)}${reason}`;
}
