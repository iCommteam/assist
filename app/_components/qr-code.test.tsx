import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { QrCode } from "./qr-code";

const uri =
  "otpauth://totp/iCommAssist:member%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=iCommAssist";

describe("authenticator QR code", () => {
  it("draws every dark module of the encoded URI locally", () => {
    const html = renderToStaticMarkup(createElement(QrCode, { value: uri }));
    const { data, size } = encode(uri, { border: 2, ecc: "M" });
    const darkModules = data.flat().filter(Boolean).length;
    const drawnModules = [...html.matchAll(/h(\d+)v1/gu)].reduce(
      (total, [, width]) => total + Number(width),
      0
    );

    expect(html).toContain(`viewBox="0 0 ${String(size)} ${String(size)}"`);
    expect(drawnModules).toBe(darkModules);
    expect(html).not.toContain("http");
  });
});
