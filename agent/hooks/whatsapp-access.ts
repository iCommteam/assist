import { interactions, type InteractionRequest } from "eve/events";
import { defineHook, type HookContext } from "eve/hooks";
import {
  noteWhatsappCancel,
  whatsappAccessOf,
  whatsappSessionOf,
} from "@agent/lib/whatsapp-access";
import { claimWhatsappBrowserTask } from "@db/services/whatsapp";
import { applicationOrigin } from "@shared/environment/origin";

// The kill switch of a WhatsApp chat, read again before every turn, model
// call and tool call: a full chat stops as soon as its member's number no
// longer reaches them, listed or linked, they can no longer sign in, or
// WhatsApp is locked for them or for everyone; a narrow chat stops only when
// no number reaches its member.
// The browser worker runs the same check in its own hook, since this one
// never fires for its turns. A cancel reaches the current turn only; a lock
// also ends the member's full chats
// (agent/channels/whatsapp.ts).
//
// A WhatsApp chat can show its member a question and, once per chat, the
// usage limit's "continue?"; a full chat also shows an approval, which the
// channel draws as a numbered message (agent/channels/whatsapp.ts). Every
// other request stops the turn: a sign-in, which needs a screen, a narrow
// chat's approval, and a second usage-limit prompt. A full chat starts at
// most 10 browser workers a day per member.
const browserTasksPerDay = 10;
const budgetNotice =
  "This chat has reached its usage limit again. Reply /new to start a new chat.";
const screenNotice =
  "That step can't be done on WhatsApp. Continue in assist's web app.";
const browserNotice = `That's the limit of ${String(browserTasksPerDay)} browser tasks a day on WhatsApp. Continue in assist's web app.`;

// Google's sign-in in a full chat, when Google stopped accepting the member's
// grant during the turn: they reconnect on the Workspace page, whose link
// goes bare on its own line.
function googleNotice() {
  return `Google needs you to connect it again. Press Reconnect under Connectors on assist's Workspace page:\n${new URL("/", applicationOrigin()).toString()}`;
}

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      await checkAccess(ctx);
    },
    async "model.requested"(_event, ctx) {
      await checkAccess(ctx);
    },
    async "call.requested"(_event, ctx) {
      await checkAccess(ctx);
    },
    async "task.started"(event, ctx) {
      const member = whatsappSessionOf(ctx.session.auth.initiator);
      if (member?.level !== "full" || event.data.name !== "run_browser") {
        return;
      }
      let claimed: boolean;
      try {
        claimed = await claimWhatsappBrowserTask(
          event.data.taskId,
          member.principalId,
          browserTasksPerDay
        );
      } catch (error) {
        console.warn("[whatsapp] the browser cap could not be read", {
          error: error instanceof Error ? error.name : "unknown",
        });
        claimed = false;
      }
      if (claimed) return;
      noteWhatsappCancel(ctx.session.id, ctx.turn?.id, browserNotice);
      ctx.cancel("The member's WhatsApp browser tasks for today are used up.");
    },
    "interaction.opened"(event, ctx) {
      const member = whatsappSessionOf(ctx.session.auth.initiator);
      if (!member) return;
      const { request } = event.data;
      if (request.kind === "question") return;
      if (request.kind === "approval" && member.level === "full") return;
      if (request.kind === "budget") {
        const asked = interactions(ctx.view).filter(
          (interaction) => interaction.request.kind === "budget"
        ).length;
        if (asked <= 1) return;
        noteWhatsappCancel(ctx.session.id, ctx.turn?.id, budgetNotice);
        ctx.cancel("The WhatsApp chat reached its usage limit again.");
        return;
      }
      console.warn("[whatsapp] chat stopped at a request it cannot show", {
        kind: request.kind,
      });
      noteWhatsappCancel(
        ctx.session.id,
        ctx.turn?.id,
        member.level === "full" && isGoogleSignIn(request)
          ? googleNotice()
          : screenNotice
      );
      ctx.cancel("The WhatsApp chat needs a step that WhatsApp cannot show.");
    },
  },
});

function isGoogleSignIn(request: InteractionRequest) {
  if (request.kind !== "sign-in") return false;
  const { displayName, grant, name } = request.signIn ?? {};
  return [displayName, grant, name].some(
    (value) => value?.toLowerCase() === "google"
  );
}

// A full chat fails closed: when the access cannot be read, the turn stops.
// A narrow chat, which reaches nothing but the reply and the web, goes on.
async function checkAccess(ctx: HookContext) {
  const member = whatsappSessionOf(ctx.session.auth.initiator);
  if (!member) return;
  let access: Awaited<ReturnType<typeof whatsappAccessOf>>;
  try {
    access = await whatsappAccessOf(member);
  } catch (error) {
    console.warn("[whatsapp] access could not be read", {
      error: error instanceof Error ? error.name : "unknown",
    });
    if (member.level === "full") {
      ctx.cancel("WhatsApp access could not be checked.");
    }
    return;
  }
  if (member.level === "full" ? access === "full" : access !== "none") return;
  ctx.cancel(
    member.level === "full"
      ? "WhatsApp full access is off for this member."
      : "This WhatsApp number no longer reaches the chat's member."
  );
}
