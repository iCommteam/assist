import {
  authenticateSiteRequest,
  siteJson,
} from "@app/api/site/_lib/site-auth";

export async function GET(request: Request) {
  const caller = await authenticateSiteRequest(request);
  if (!caller.ok) return caller.response;
  return siteJson({ ok: true, site: caller.site });
}
