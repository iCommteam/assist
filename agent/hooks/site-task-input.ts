import { defineHook } from "eve/hooks";
import { siteOfSession } from "@agent/lib/site-principal";
import { isSiteCodeQuestion } from "@shared/identity/site-code/question";

// A site can answer only the browser worker's one-time code question. Any
// other request, such as the usage limit's "continue?" prompt or a tool
// approval, would hold a site task open forever, so the turn stops there and
// the site API reports it as failed. The check reads the initiator, so it
// holds for turns the owner writes into a site task's chat too.
export default defineHook({
  events: {
    "interaction.opened"(event, ctx) {
      const site = siteOfSession(ctx.session.auth.initiator);
      const { request } = event.data;
      if (!site || isSiteCodeQuestion(request)) return;
      console.warn("[site] task stopped at a request a site cannot answer", {
        kind: request.kind,
        site,
      });
      ctx.cancel(
        request.kind === "budget"
          ? "The site task reached its usage limit."
          : "The site task needs an answer that a site cannot give."
      );
    },
  },
});
