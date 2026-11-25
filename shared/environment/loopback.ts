import { readFile } from "node:fs/promises";
import { z } from "zod";
import { env } from "@shared/environment";

const eveDevServerSchema = z.object({
  appRoot: z.string(),
  origin: z.url(),
});

// A callback to one of the eve server's own routes outside its protocol
// namespace, which Next never proxies. Every caller runs beside the eve
// server, in it or in Next on the same machine, so the call goes straight to
// it over loopback and never leaves the machine. The channels that own those
// routes accept only SCHEDULED_RUN_SECRET as the bearer
// (agent/lib/schedules/request.ts).
export async function postLoopbackRoute(
  route: `/internal/${string}`,
  body: Readonly<Record<string, string>>
) {
  const secret = env.SCHEDULED_RUN_SECRET;
  if (!secret) {
    throw new Error(
      "Loopback callbacks are disabled. Set SCHEDULED_RUN_SECRET."
    );
  }
  return fetch(new URL(route, await eveLoopbackOrigin()), {
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
async function eveLoopbackOrigin() {
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

interface WhatsappLoopbackBodies {
  "/internal/whatsapp/end": { member: string };
}

// The WhatsApp channel's callback (agent/channels/whatsapp.ts): ending the
// chats a lock covers.
export async function postWhatsappLoopback<
  Route extends keyof WhatsappLoopbackBodies,
>(route: Route, body: WhatsappLoopbackBodies[Route]) {
  return postLoopbackRoute(route, body);
}
