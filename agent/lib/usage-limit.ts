import type { TokenUsage } from "eve";

// Claude Opus 5.5 list prices on the direct Anthropic API, in US dollars per
// million tokens. eve reports costUsd only through AI Gateway, so the spend is
// estimated from token counts. inputTokens includes cache reads and writes.
const pricePerMillionTokens = {
  cacheRead: 0.2,
  cacheWrite: 5,
  input: 4,
  output: 20,
};

// Each time a session's estimated model spend since its last approved
// continuation reaches this, eve pauses the turn and asks to continue or stop.
// A session that cannot ask, such as a scheduled run or a browser worker,
// fails its next model call instead. A subagent's spend also counts in its
// parent's window once it replies.
const windowBudgetUsd = 10;

function estimatedCostUsd(usage: TokenUsage) {
  const uncachedInput = Math.max(
    0,
    usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens
  );
  return (
    (uncachedInput * pricePerMillionTokens.input +
      usage.cacheReadTokens * pricePerMillionTokens.cacheRead +
      usage.cacheWriteTokens * pricePerMillionTokens.cacheWrite +
      usage.outputTokens * pricePerMillionTokens.output) /
    1_000_000
  );
}

export function sessionUsageExceeded({
  window,
}: {
  readonly window: TokenUsage;
}) {
  return estimatedCostUsd(window) >= windowBudgetUsd;
}
