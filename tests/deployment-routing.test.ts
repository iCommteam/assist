import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import scheduledRun from "@agent/channels/scheduled-run";

it("keeps the scheduled callbacks outside Eve's protocol namespace with no Vercel routing", () => {
  expect(existsSync("vercel.json")).toBe(false);
  const callbackPaths = scheduledRun.routes.map((route) => route.path);
  expect(callbackPaths).toHaveLength(2);
  for (const path of callbackPaths) {
    // Authored routes must stay outside Eve's reserved protocol namespace.
    expect(path.startsWith("/eve/v1/")).toBe(false);
  }
});
