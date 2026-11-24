import { defineHook, type HookContext } from "eve/hooks";
import { siteChatOfSession } from "@agent/lib/site-principal";
import { clearSiteChatToken } from "@db/services/site-chats";

// A site chat relays the agent's questions to its person, who answers through
// the site. Nothing else can be answered there: the usage limit's "continue?"
// is answered no, which stops the turn (the stream reports usage_limit), and
// an approval or a sign-in stops it too. The site's token for its own tools
// lasts one turn: the site sends it again with the next message.
export default defineHook({
  events: {
    "interaction.opened"(event, ctx) {
      const chat = siteChatOfSession(ctx.session.auth.initiator);
      const { request } = event.data;
      if (!chat || request.kind === "question") return;
      console.warn("[site] chat stopped at a request its site cannot answer", {
        kind: request.kind,
        site: chat.site,
      });
      ctx.cancel(
        request.kind === "budget"
          ? "The chat reached its usage limit."
          : "The chat needs an answer that its site cannot give."
      );
    },
    async "turn.settled"(_event, ctx) {
      await forgetToken(ctx);
    },
    async "session.ended"(_event, ctx) {
      await forgetToken(ctx);
    },
  },
});

async function forgetToken(ctx: HookContext) {
  const chat = siteChatOfSession(ctx.session.auth.initiator);
  if (!chat) return;
  try {
    await clearSiteChatToken(ctx.session.id);
  } catch (error) {
    // The token runs out by itself; a failed clear must not fail the turn.
    console.warn("[site] chat token could not be cleared", {
      error: error instanceof Error ? error.name : "unknown",
      site: chat.site,
    });
  }
}
