import { defineHook } from "eve/hooks";
import { siteChatOfSession } from "@agent/lib/site-principal";

// A site chat relays the agent's questions to its person, who answers through
// the site. Nothing else can be answered there: the usage limit's "continue?"
// is answered no, which stops the turn (the stream reports usage_limit), and
// an approval or a sign-in stops it too.
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
  },
});
