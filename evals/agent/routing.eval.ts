import { defineEval } from "eve/evals";
import {
  agentEvalTags,
  assertPlainTextDelivery,
  requireDeliveredText,
} from "@evals/agent/shared";

export default [
  defineEval({
    description: "Uses public search for discovery instead of a browser worker",
    tags: [...agentEvalTags, "routing"],
    async test(t) {
      const turn = await t.send(
        "Find the official website for Brooklyn Botanic Garden. Give me its name and URL. This is public research; do not interact with the site."
      );
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("web_search");
      turn.notEvent("child.opened", { data: { name: "browser-agent" } });
      const text = await requireDeliveredText(t, turn);
      t.judge(
        "The response identifies Brooklyn Botanic Garden and gives its official website URL, without claiming to have interacted with the site.",
        { on: text }
      )
        .label("public discovery result")
        .atLeast(0.8);
      assertPlainTextDelivery(t, text);
    },
  }),
  defineEval({
    description: "Drafts an email without sending or delegating",
    tags: [...agentEvalTags, "routing", "smoke"],
    async test(t) {
      const turn = await t.send(
        "Draft a two-sentence email to a neighbor asking whether they can water my plants this weekend. Do not send it."
      );
      turn.expectOk();
      turn.succeeded();
      turn.notEvent("child.opened", { data: { name: "browser-agent" } });
      const text = await requireDeliveredText(t, turn);
      t.judge(
        "The response provides a usable two-sentence email draft asking a neighbor to water plants this weekend and does not claim it was sent.",
        { on: text }
      )
        .label("draft-only boundary")
        .atLeast(0.8);
      assertPlainTextDelivery(t, text);
    },
  }),
];
