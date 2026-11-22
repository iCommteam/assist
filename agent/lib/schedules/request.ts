import { readFile } from "node:fs/promises";
import { z } from "zod";
import { env } from "@shared/environment";

const eveDevServerSchema = z.object({
  appRoot: z.string(),
  origin: z.url(),
});

interface ScheduledRunRequestBodies {
  "/internal/scheduled-run/report": { runId: string };
  "/internal/scheduled-run/respond": {
    answer: string;
    leaseToken: string;
    runId: string;
  };
}

// Both callers run inside the eve server, so a callback goes straight back to
// it over loopback and never leaves the machine or passes through Next. The
// scheduled-run channel accepts only SCHEDULED_RUN_SECRET as the bearer.
export async function postScheduledRunRoute<
  Route extends keyof ScheduledRunRequestBodies,
>(route: Route, body: ScheduledRunRequestBodies[Route]) {
  const secret = env.SCHEDULED_RUN_SECRET;
  if (!secret) {
    throw new Error(
      "Scheduled-run callbacks are disabled. Set SCHEDULED_RUN_SECRET."
    );
  }
  const origin = await scheduledRunOrigin();
  return fetch(new URL(route, origin), {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "error",
  });
}

// `eve dev` listens on a port it picks itself and records it for Next; every
// other process is the eve server that `withEve` starts beside `next start`.
async function scheduledRunOrigin() {
  if (env.NODE_ENV === "development") {
    try {
      const registry = eveDevServerSchema.parse(
        JSON.parse(await readFile(".eve/next-dev-server.json", "utf8"))
      );
      if (registry.appRoot === process.cwd()) {
        return new URL(registry.origin).origin;
      }
    } catch {
      // Standalone development does not create the Next.js server registry.
    }
  }
  return `http://127.0.0.1:${String(env.EVE_NEXT_PRODUCTION_PORT ?? 4274)}`;
}

export async function postScheduledReport(runId: string) {
  const response = await postScheduledRunRoute(
    "/internal/scheduled-run/report",
    { runId }
  );
  if (response.status !== 202) {
    throw new Error(
      `Scheduled report callback failed (${String(response.status)}).`
    );
  }
}
