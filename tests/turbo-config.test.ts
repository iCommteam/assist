import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const applicationEnvironment = [
  "BETTER_AUTH_*",
  "BLOB_*",
  "DATABASE_URL",
  "KERNEL_*",
  "LINQ_*",
  "LINK_*",
  "STRIPE_PUBLISHABLE_KEY",
  "NODE_ENV",
  "SECRET_ENCRYPTION_KEY",
  "VERCEL_*",
];
const runtimeEnvironment = applicationEnvironment;

describe("Turbo configuration", () => {
  it("scopes application environment variables to their owning tasks", async () => {
    const turbo = z
      .object({
        tasks: z.object({
          "build:app": z.object({ env: z.array(z.string()) }),
          "dev:app": z.object({ passThroughEnv: z.array(z.string()) }),
          "start:app": z.object({ passThroughEnv: z.array(z.string()) }),
        }),
      })
      .loose()
      .parse(
        JSON.parse(
          await readFile(new URL("../turbo.json", import.meta.url), "utf8")
        )
      );

    expect(turbo).not.toHaveProperty("globalEnv");
    expect(turbo.tasks).not.toHaveProperty("build:vercel");
    expect(turbo.tasks).not.toHaveProperty("deploy:app");
    expect(turbo.tasks["build:app"].env).toEqual(
      expect.arrayContaining([...applicationEnvironment, "EVE_NEXT_*"])
    );
    expect(turbo.tasks["build:app"].env).toHaveLength(
      applicationEnvironment.length + 1
    );
    expect(turbo.tasks["dev:app"].passThroughEnv).toEqual(runtimeEnvironment);
    expect(turbo.tasks["start:app"].passThroughEnv).toEqual(runtimeEnvironment);
  });

  it("documents a Railway deployment with no Vercel deploy path", async () => {
    const readme = await readFile(
      new URL("../README.md", import.meta.url),
      "utf8"
    );
    const manifest = z
      .object({
        devDependencies: z.record(z.string(), z.string()),
        scripts: z.record(z.string(), z.string()),
      })
      .parse(
        JSON.parse(
          await readFile(new URL("../package.json", import.meta.url), "utf8")
        )
      );

    expect(readme).not.toContain("vercel.com/new/clone");
    expect(readme).toContain("## Deployment on Railway");
    expect(readme).toContain("pnpm db:migrate");
    expect(manifest.scripts).not.toHaveProperty("build:vercel");
    expect(manifest.scripts).not.toHaveProperty("deploy");
    expect(manifest.scripts).not.toHaveProperty("deploy:app");
    expect(manifest.devDependencies).not.toHaveProperty("vercel");
  });
});
