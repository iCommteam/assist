import { applicationOrigin } from "@shared/environment/origin";

const privateHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

// A redirect on assist's own origin. Nothing is cached and no Referer
// leaves, since a flow's URL carries its state.
export function seeOther(location: string) {
  return new Response(null, {
    headers: { ...privateHeaders, Location: location },
    status: 303,
  });
}

export function privateJson(
  body: Readonly<Record<string, string>>,
  status: number
) {
  return Response.json(body, { headers: privateHeaders, status });
}

// The Workspace page's Connectors section, saying how the last step went.
export function connectorsPage(outcome: string) {
  const url = new URL("/", applicationOrigin());
  url.searchParams.set("google", outcome);
  url.hash = "connectors";
  return seeOther(url.toString());
}
