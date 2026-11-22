import type { NextConfig } from "next";
import { withEve } from "eve/next";

// Sent on pages, route handlers, redirects and static files. The app is never
// framed, never sends a Referer (chat links and the live-view redirect
// included), and asks the browser for no device features. Responses Next
// proxies from the eve server (/eve/*: JSON and event streams) do not get them;
// neither these headers nor ones set in proxy.ts reach a proxied response.
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "autoplay=()",
      "bluetooth=()",
      "camera=()",
      "display-capture=()",
      "geolocation=()",
      "gyroscope=()",
      "hid=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "serial=()",
      "usb=()",
      "xr-spatial-tracking=()",
    ].join(", "),
  },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  headers() {
    return Promise.resolve([{ headers: securityHeaders, source: "/:path*" }]);
  },
};

export default withEve(nextConfig);
