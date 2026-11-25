import { defineHook, type HookContext } from "eve/hooks";
import {
  whatsappAccessOf,
  whatsappRootAccessOf,
  whatsappSessionOf,
} from "@agent/lib/whatsapp-access";

// The root agent's WhatsApp kill switch (agent/hooks/whatsapp-access.ts)
// never fires for a worker's turns, and a background worker runs on after
// the root's turn settles. So a worker of a full WhatsApp chat checks the
// chat's access itself, before every turn, model call and tool call, and
// stops once the member locked WhatsApp, lost their number or can no longer
// sign in. A worker of any other chat goes on as before.
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      await checkRootAccess(ctx);
    },
    async "model.requested"(_event, ctx) {
      await checkRootAccess(ctx);
    },
    async "call.requested"(_event, ctx) {
      await checkRootAccess(ctx);
    },
  },
});

async function checkRootAccess(ctx: HookContext) {
  const root = ctx.session.parent?.rootSessionId;
  if (!root) return;
  const access = await whatsappRootAccessOf(root);
  if (access !== undefined && access !== "unknown") {
    if (access.level !== "full") {
      ctx.cancel("WhatsApp full access is off for this member.");
    }
    return;
  }
  // No row for the root chat yet, or none could be read: a worker that a
  // WhatsApp message started still carries the member's principal, so its
  // access is checked from that, and it stops when that cannot be read.
  const member = whatsappSessionOf(ctx.session.auth.initiator);
  if (member?.level !== "full") return;
  let level: Awaited<ReturnType<typeof whatsappAccessOf>>;
  try {
    level = await whatsappAccessOf(member);
  } catch {
    level = "none";
  }
  if (level !== "full") {
    ctx.cancel("WhatsApp full access is off for this member.");
  }
}
