import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttachmentPart } from "./attachment";

function render(url: string) {
  return renderToStaticMarkup(
    createElement(AttachmentPart, {
      part: {
        filename: "photo.png",
        mediaType: "image/png",
        type: "file",
        url,
      },
    })
  );
}

describe("chat attachments", () => {
  it("previews only the app's own artifact images", () => {
    const artifact = render("/artifacts/0d01e667-d128-4bb7-a248-1ae21db72f4f");
    expect(artifact).toContain("<img");
    expect(artifact).toMatch(/referrerpolicy="no-referrer"/iu);

    const remote = render("https://tracker.example.com/pixel.png");
    expect(remote).not.toContain("<img");
    // The link stays, so the member can still open it on purpose.
    expect(remote).toContain('href="https://tracker.example.com/pixel.png"');
  });
});
