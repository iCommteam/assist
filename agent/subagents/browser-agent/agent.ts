import { defineAgent } from "eve";
import { anthropicModel, MODEL_CONTEXT_WINDOW_TOKENS } from "@agent/lib/models";

// Static: a dynamic subagent must return a serializable model id, and a direct
// Anthropic model is an instance. Which modes may start a browser is decided in
// run_browser instead.
export default defineAgent({
  tool: false,
  description:
    "Execute one bounded browser assignment for the root coordinator, including secure vault autofill, transaction preparation, human-takeover handoff, cleanup, and a concise verified result.",
  model: anthropicModel(),
  modelContextWindowTokens: MODEL_CONTEXT_WINDOW_TOKENS,
  reasoning: "low",
  compaction: {
    threshold: 0.7,
  },
  // Retention is per agent; see agent/agent.ts.
  experimental: {
    workflow: {
      retention: "default",
    },
  },
});
