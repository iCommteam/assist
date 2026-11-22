import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// next.config.ts is evaluated by Next itself (withEve starts the eve server in
// production), so this reads its source; the live run checks real responses.
const config = readFileSync("next.config.ts", "utf8");

describe("security headers", () => {
  it("sends the hardening headers on every path and hides the framework", () => {
    expect(config).toContain("headers: securityHeaders");
    expect(config).toContain('source: "/:path*"');
    expect(config).toContain("poweredByHeader: false");
    for (const [key, value] of [
      ["Strict-Transport-Security", "max-age=63072000; includeSubDomains"],
      ["X-Frame-Options", "DENY"],
      ["X-Content-Type-Options", "nosniff"],
      ["Referrer-Policy", "no-referrer"],
      [
        "Content-Security-Policy",
        "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
      ],
    ] as const) {
      expect(config).toMatch(
        new RegExp(`key: "${key}",?\\s*value: "${value}"`, "u")
      );
    }
    expect(config).toContain('key: "Permissions-Policy"');
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(config).toContain(`"${feature}=()"`);
    }
  });
});
