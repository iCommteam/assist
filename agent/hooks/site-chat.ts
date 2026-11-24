import { deliveries } from "eve/events";
import { defineHook, type HookContext } from "eve/hooks";
import { siteChatOfSession } from "@agent/lib/site-principal";
import { clearSiteChatToken } from "@db/services/site-chats";

// A site chat relays the agent's questions to its person, who answers through
// the site. Nothing else can be answered there: the usage limit's "continue?"
// is answered no, which stops the turn (the stream reports usage_limit), and
// an approval or a sign-in stops it too. The site's token for its own tools
// lasts the turn it came for: the site sends it again with the next message.
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
    async "turn.settled"(event, ctx) {
      await forgetToken(ctx, () => lastArrivalOf(ctx, event.data.turnId));
    },
    async "session.ended"(_event, ctx) {
      await forgetToken(ctx, () => undefined);
    },
  },
});

// When the last message or answer the turn took arrived. The site's routes
// store its token just before they send, so a token stored after that came
// with a message the turn never took, such as a result posted as the turn
// settled, and the next turn needs it.
function lastArrivalOf(ctx: HookContext, turnId: string) {
  const arrivals = deliveries(ctx.view, { turnId }).flatMap(({ startedAt }) => {
    const at = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
    return Number.isFinite(at) ? [at] : [];
  });
  return arrivals.length > 0 ? new Date(Math.max(...arrivals)) : ctx.now;
}

// Only a site chat's session reads its view for the cutoff, and a cutoff that
// cannot be read fails no turn.
async function forgetToken(
  ctx: HookContext,
  arrivedBy: () => Date | undefined
) {
  const chat = siteChatOfSession(ctx.session.auth.initiator);
  if (!chat) return;
  try {
    await clearSiteChatToken(ctx.session.id, arrivedBy());
  } catch (error) {
    // The token runs out by itself; a failed clear must not fail the turn.
    console.warn("[site] chat token could not be cleared", {
      error: error instanceof Error ? error.name : "unknown",
      site: chat.site,
    });
  }
}
