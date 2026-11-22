import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { siteVariables } from "@shared/environment";

const minimumTokenLength = 32;
const ownerEmailSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.email());

const reportedProblems = new Set<string>();

// A misconfigured site is refused, never fatal: a short token disables it, an
// invalid owner makes every call fail with 403, and two sites sharing a token
// are both disabled. Each problem is logged once per process, values never.
function configuredSites() {
  const candidates = siteVariables().flatMap((site) => {
    if (site.token.length < minimumTokenLength) {
      reportOnce(
        `${site.tokenVariable} is shorter than ${String(minimumTokenLength)} characters; the site is disabled.`
      );
      return [];
    }
    const owner = ownerEmailSchema.safeParse(site.owner);
    if (!owner.success) {
      reportOnce(
        `${site.ownerVariable} is not a valid email; every call from the site is refused.`
      );
    }
    return [
      {
        name: site.name,
        ownerEmail: owner.success ? owner.data : undefined,
        tokenDigest: digest(site.token),
      },
    ];
  });
  return candidates.filter((site) => {
    const shared = candidates.some(
      (other) => other !== site && other.tokenDigest.equals(site.tokenDigest)
    );
    if (shared) {
      reportOnce(
        `The site "${site.name}" shares its token with another site; both are disabled.`
      );
    }
    return !shared;
  });
}

// Names the site whose token this is. Every configured token is compared, in
// constant time on equal-length digests, so the timing reveals nothing.
export function siteForToken(token: string) {
  const presented = digest(token);
  let match: string | undefined;
  for (const site of configuredSites()) {
    if (timingSafeEqual(presented, site.tokenDigest)) match = site.name;
  }
  return match;
}

export function siteOwnerEmail(site: string) {
  return configuredSites().find(({ name }) => name === site)?.ownerEmail;
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

function reportOnce(problem: string) {
  if (reportedProblems.has(problem)) return;
  reportedProblems.add(problem);
  console.warn(`[site] ${problem}`);
}
