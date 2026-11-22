import { resolveSiteOwner } from "@db/services/sites";
import { siteForToken } from "@shared/environment/sites";

const noStore = { "cache-control": "no-store" };

// Every site API body is a flat JSON object of strings, booleans and nulls.
export function siteJson(
  body: Readonly<Record<string, string | boolean | null>>,
  status = 200
) {
  return Response.json(body, { headers: noStore, status });
}

export function siteError(status: number, error: string) {
  return siteJson({ error }, status);
}

// The site API authenticates by bearer token alone: it never reads cookies, so
// a browser session cannot reach it. A known site whose owner cannot sign in
// is refused as a whole, with the reason in the server log only.
export async function authenticateSiteRequest(request: Request) {
  const token = /^Bearer[ \t]+(\S+)[ \t]*$/iu.exec(
    request.headers.get("authorization") ?? ""
  )?.[1];
  const site = token ? siteForToken(token) : undefined;
  if (!site) {
    return { ok: false as const, response: siteError(401, "unauthorized") };
  }
  let owner: Awaited<ReturnType<typeof resolveSiteOwner>>;
  try {
    owner = await resolveSiteOwner(site);
  } catch (error) {
    console.warn("[site] owner lookup failed", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
    return { ok: false as const, response: siteError(503, "unavailable") };
  }
  if (!owner.ok) {
    console.warn("[site] call refused", { reason: owner.reason, site });
    return { ok: false as const, response: siteError(403, "forbidden") };
  }
  return { ok: true as const, owner, site };
}
