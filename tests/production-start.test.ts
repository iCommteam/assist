import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SUPERVISOR_TEST_TIMEOUT_MS,
  waitForSupervisorClose,
  waitForSupervisorLogEntry,
} from "./helpers/supervisor-process";

const temporaryDirectories: string[] = [];
const startTestOptions = { timeout: SUPERVISOR_TEST_TIMEOUT_MS };

const productionEnvironment = {
  ANTHROPIC_API_KEY: "anthropic-key-that-must-not-leak",
  ASSIST_ALLOWED_EMAILS: "member@example.test",
  ASSIST_SIGNUP_CODE: "signup-code-0123456789",
  BETTER_AUTH_SECRET: "better-auth-secret-that-must-not-leak-0123",
  BETTER_AUTH_URL: "https://assist.example.test",
  DATABASE_URL: "postgresql://user:password@db.internal/assist",
  KERNEL_API_KEY: "kernel-key-that-must-not-leak",
  NODE_ENV: "production",
  PORT: "4310",
  SCHEDULED_RUN_SECRET: "scheduled-run-secret-that-must-not-leak-01",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} satisfies NodeJS.ProcessEnv;

// Stands in for `next start`: records how it was started and how it stopped,
// and exits 143 on SIGTERM as Next does.
const fakeNext = `const { appendFileSync } = require("node:fs");
const log = (line) => appendFileSync(process.env.FAKE_NEXT_LOG, line + "\\n");
log("started " + process.argv.slice(2).join(" ") + " port=" + process.env.PORT);
process.on("SIGTERM", () => { log("SIGTERM"); process.exit(143); });
const exitCode = Number(process.env.FAKE_NEXT_EXIT_CODE ?? "-1");
if (exitCode >= 0) process.exit(exitCode);
setInterval(() => {}, 1000);
`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    })
  );
});

describe("production start", startTestOptions, () => {
  it("refuses an unsafe environment before starting Next", async () => {
    const result = await runStart({
      ...productionEnvironment,
      BETTER_AUTH_SECRET: "openinstinct-local-auth-development-secret",
      EVE_DEV: "1",
      SCHEDULED_RUN_SECRET: "",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("[start] Refusing to start:");
    expect(result.stderr).toContain("- EVE_DEV must be unset in production.");
    expect(result.stderr).toContain(
      "- BETTER_AUTH_SECRET must not be the local development default."
    );
    expect(result.stderr).toContain("- SCHEDULED_RUN_SECRET is required.");
    const secrets = Object.values(productionEnvironment).filter(
      (value) => value.length >= 16
    );
    for (const value of secrets) {
      expect(result.stderr).not.toContain(value);
    }
    expect(result.nextLog).toBe("");
  });

  it("refuses to start outside production", async () => {
    const result = await runStart({
      ...productionEnvironment,
      NODE_ENV: "development",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('- NODE_ENV must be "production".');
    expect(result.nextLog).toBe("");
  });

  it("starts next start on PORT and stops cleanly on SIGTERM", async () => {
    const result = await runStart(productionEnvironment, {
      afterStart: "SIGTERM",
    });

    expect(result.code).toBe(0);
    expect(result.nextLog).toBe("started start port=4310\nSIGTERM\n");
  });

  it("exits with Next's failure code", async () => {
    const result = await runStart({
      ...productionEnvironment,
      FAKE_NEXT_EXIT_CODE: "3",
    });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain(
      "[start] Next exited unexpectedly (code 3)."
    );
  });

  it("treats Next exiting cleanly on its own as a failure", async () => {
    const result = await runStart({
      ...productionEnvironment,
      FAKE_NEXT_EXIT_CODE: "0",
    });

    expect(result.code).toBe(1);
  });
});

// Runs a copy of the start script next to a fake `next` package, so the real
// script resolves and spawns the fake instead of the installed Next.
async function runStart(
  environment: NodeJS.ProcessEnv,
  { afterStart }: { afterStart?: NodeJS.Signals } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "assist-start-"));
  temporaryDirectories.push(root);
  const repository = new URL("..", import.meta.url);
  await Promise.all([
    mkdir(join(root, "scripts")),
    mkdir(join(root, "shared/environment"), { recursive: true }),
    mkdir(join(root, "node_modules/next/dist/bin"), { recursive: true }),
  ]);
  const nextLog = join(root, "next.log");
  await Promise.all([
    cp(new URL("scripts/start.ts", repository), join(root, "scripts/start.ts")),
    cp(
      new URL("shared/environment/production.ts", repository),
      join(root, "shared/environment/production.ts")
    ),
    writeFile(join(root, "package.json"), '{"type":"module"}'),
    writeFile(
      join(root, "node_modules/next/package.json"),
      '{"name":"next","version":"0.0.0"}'
    ),
    writeFile(join(root, "node_modules/next/dist/bin/next"), fakeNext),
    writeFile(nextLog, ""),
  ]);

  const start = spawn(
    process.execPath,
    ["--experimental-strip-types", join(root, "scripts/start.ts")],
    {
      cwd: root,
      env: { ...environment, FAKE_NEXT_LOG: nextLog },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  let stderr = "";
  start.stderr.setEncoding("utf8");
  start.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = waitForSupervisorClose(start);
  if (afterStart) {
    await waitForSupervisorLogEntry(nextLog, "started");
    start.kill(afterStart);
  }
  const code = await exit;
  return { code, nextLog: await readFile(nextLog, "utf8"), stderr };
}
