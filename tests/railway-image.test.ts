import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const appRoot = "/app";
const volume = "/app/.eve/.workflow-data";
// eve's just-bash provider keeps each session's root here (the sandbox cache
// directory, then `just-bash/sessions/<id>`), beside the build's templates.
const sessionsPath = ".eve/sandbox-cache/just-bash/sessions";

async function repositoryFile(name: string) {
  return await readFile(new URL(`../${name}`, import.meta.url), "utf8");
}

async function startSteps() {
  const dockerfile = await repositoryFile("Dockerfile");
  const line = dockerfile.split("\n").find((entry) => entry.startsWith("CMD "));
  const [, , command] = z
    .tuple([z.literal("sh"), z.literal("-c"), z.string()])
    .parse(JSON.parse(line?.slice("CMD ".length) ?? "null"));
  return { dockerfile, steps: command.split(" && ") };
}

describe("Railway image", () => {
  it("documents the port Teemiq's private address uses", async () => {
    const readme = await repositoryFile("README.md");
    const { dockerfile } = await startSteps();

    expect(readme).toContain("http://assist.railway.internal:8080");
    expect(readme).toContain("`PORT=8080`");
    expect(readme).not.toMatch(/`PORT`[^\n]*3000/u);
    expect(dockerfile).toContain("\nEXPOSE 8080\n");
  });

  it("never lets pnpm reinstall inside the image", async () => {
    const { dockerfile } = await startSteps();
    const lines = dockerfile.split("\n");
    const setting = lines.indexOf(
      "ENV pnpm_config_verify_deps_before_run=false"
    );

    // Set after the install, so the install layer stays cached, and before
    // the build's `pnpm exec`; ENV also reaches the pre-deploy `pnpm run`.
    expect(setting).toBeGreaterThan(
      lines.findIndex((line) => line.startsWith("RUN pnpm install "))
    );
    expect(setting).toBeLessThan(
      lines.findIndex((line) => line.includes("pnpm exec eve build"))
    );
  });

  it("keeps each session's sandbox files on the volume, across restarts", async () => {
    const readme = await repositoryFile("README.md");
    const { dockerfile, steps } = await startSteps();
    expect(dockerfile).toContain(`\nWORKDIR ${appRoot}\n`);
    expect(readme).toContain(`mounted at exactly \`${volume}\``);

    const link = steps.find((step) => step.startsWith("ln "));
    const [, flags, target, linkPath] = link?.split(" ") ?? [];
    // -f and -n replace the link a previous start made instead of failing.
    expect(flags).toBe("-sfn");
    expect(linkPath).toBe(sessionsPath);
    const sessions = path.posix.resolve(
      appRoot,
      path.posix.dirname(sessionsPath),
      target ?? ""
    );
    expect(path.posix.dirname(sessions)).toBe(volume);

    const index = (prefix: string) =>
      steps.findIndex((step) => step.startsWith(prefix));
    const relative = path.posix.relative(appRoot, sessions);
    // The target exists, and belongs to node, before the link points at it;
    // a directory the image may hold at the link path is removed first.
    expect(steps[index("mkdir ")]).toContain(relative);
    expect(index("mkdir ")).toBeLessThan(index("find "));
    expect(steps[index("find ")]).toContain(path.posix.dirname(relative));
    expect(steps).toContain(`rm -rf ${sessionsPath}`);
    expect(index("rm -rf ")).toBeLessThan(index("ln "));
    expect(index("ln ")).toBeLessThan(index("exec setpriv "));
  });
});
