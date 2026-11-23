import type { SessionContext } from "eve/context";
import { readBrowserSession } from "@db/services/browsers";
import type { AccessScope } from "@shared/identity/access-scope";

// A worker reaches only the browsers it created. Another task's browser may be
// signed in to another account, so it reads as missing rather than refused.
export async function requireOwnedBrowserSession(
  scope: AccessScope,
  worker: Pick<SessionContext["session"], "id">,
  sessionId: string
) {
  const record = await readBrowserSession(scope, sessionId);
  if (!record || record.workerSessionId !== worker.id) {
    throw new Error("Browser session not found.");
  }
  return record;
}
