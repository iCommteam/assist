// The production entrypoint, run by the Dockerfile. It refuses an unsafe
// configuration, starts `next start` (which spawns the eve server beside it on
// 127.0.0.1:4274), forwards shutdown signals, and exits non-zero when eve
// stops answering: nothing else restarts the eve child once it is up, so the
// platform's restart policy has to.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { productionEnvironmentProblems } from "../shared/environment/production.ts";

// oxlint-disable-next-line eslint/no-restricted-properties -- the entrypoint checks the environment it was given before anything else loads
const problems = productionEnvironmentProblems(process.env);
if (problems.length > 0) {
  console.error(
    [
      "[start] Refusing to start:",
      ...problems.map((problem) => `- ${problem}`),
    ].join("\n")
  );
  process.exit(1);
}

const eveHealthUrl = "http://127.0.0.1:4274/eve/v1/health";
// eve gives its server 180 s to start; Railway's health check waits 300 s.
const startupLimitMs = 300_000;
const startupPollMs = 2_000;
const healthPollMs = 10_000;
const healthTimeoutMs = 5_000;
const healthFailureLimit = 3;
const shutdownGraceMs = 15_000;

// Next reads PORT itself. Without a hostname Node listens on every address,
// IPv6 included, which Railway's private network uses.
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const next = spawn(process.execPath, [nextBin, "start"], { stdio: "inherit" });
const startedAt = Date.now();

let stopping = false;
let failed = false;
let healthy = false;
let failures = 0;
let healthTimer: NodeJS.Timeout | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stop(signal);
  });
}

next.once("error", (error) => {
  console.error(`[start] Next could not start: ${error.message}`);
  process.exit(1);
});

next.once("exit", (code, signal) => {
  clearTimeout(healthTimer);
  if (failed) process.exit(1);
  // A requested stop is a clean exit, whatever code Next stops with (143).
  if (stopping) process.exit(0);
  console.error(
    `[start] Next exited unexpectedly (${signal ?? `code ${String(code)}`}).`
  );
  process.exit(code === null || code === 0 ? 1 : code);
});

scheduleHealthCheck(startupPollMs);

function scheduleHealthCheck(delayMs: number) {
  healthTimer = setTimeout(() => {
    void checkEve();
  }, delayMs);
}

async function checkEve() {
  const answered = await eveAnswers();
  if (stopping) return;
  if (answered) {
    if (!healthy) console.info("[start] eve is answering its health check.");
    healthy = true;
    failures = 0;
  } else if (healthy) {
    failures += 1;
    if (failures >= healthFailureLimit) {
      fail(`eve failed its health check ${String(failures)} times in a row.`);
      return;
    }
  } else if (Date.now() - startedAt >= startupLimitMs) {
    fail(
      `eve did not answer its health check within ${String(startupLimitMs / 1000)} s.`
    );
    return;
  }
  scheduleHealthCheck(healthy ? healthPollMs : startupPollMs);
}

async function eveAnswers() {
  try {
    const response = await fetch(eveHealthUrl, {
      signal: AbortSignal.timeout(healthTimeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function fail(reason: string) {
  console.error(`[start] ${reason} Stopping so the service restarts.`);
  failed = true;
  stop("SIGTERM");
}

function stop(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  clearTimeout(healthTimer);
  next.kill(signal);
  setTimeout(() => {
    next.kill("SIGKILL");
  }, shutdownGraceMs).unref();
}
