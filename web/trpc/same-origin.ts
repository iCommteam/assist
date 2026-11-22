import { applicationOrigin } from "@shared/environment/origin";

// A cookie-authenticated write must come from a page of this app, so its
// Origin header has to equal the configured application origin exactly.
// Browsers always send Origin on such requests. Host and X-Forwarded-* headers
// are not trusted: behind the edge proxy the request host is not the public
// origin, and a forwarded header is whatever the caller wrote.
export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin !== null && origin === applicationOrigin();
}
