import { defineEval } from "eve/evals";
import {
  agentEvalTags,
  assertPlainTextDelivery,
  requireDeliveredText,
} from "@evals/agent/shared";

export default [
  defineEval({
    description: "Does not save an explicitly one-off preference",
    tags: [...agentEvalTags, "memory", "smoke"],
    async test(t) {
      const turn = await t.send(
        "For today only, I want sparkling water with lunch. Do not save that as a preference."
      );
      turn.expectOk();
      turn.succeeded();
      turn.notCalledTool("personal_info__update");
      const text = await requireDeliveredText(t, turn);
      assertPlainTextDelivery(t, text);
    },
  }),
];
