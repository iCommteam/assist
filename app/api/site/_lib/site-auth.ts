import type { z } from "zod";
import { resolveSiteOwner } from "@db/services/sites";
import { siteForToken } from "@shared/environment/sites";

const noStore = { "cache-control": "no-store" };

// Every site API body is a JSON object; times travel as ISO strings.
export function siteJson(
  body: Readonly<Record<string, z.core.util.JSONType>>,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
) {
  return Response.json(body, { headers: { ...headers, ...noStore }, status });
}

export function siteNoContent() {
  return new Response(null, { headers: noStore, status: 204 });
}

export function siteError(
  status: number,
  error: string,
  headers?: Readonly<Record<string, string>>
) {
  return siteJson({ error }, status, headers);
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
