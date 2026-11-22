import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

// The authenticator of a connected site acting for its owner. The eve channel
// is the only issuer; its `site` attribute records which site sent the task.
export const siteAuthenticator = "assist-site";

// The site that created a session, or undefined for every other session.
export function siteOfSession(initiator: SessionAuthContext | null) {
  if (initiator?.authenticator !== siteAuthenticator) return undefined;
  const site = z.string().min(1).safeParse(initiator.attributes.site);
  return site.success ? site.data : undefined;
}
