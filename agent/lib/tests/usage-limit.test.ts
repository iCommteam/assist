import { describe, expect, it } from "vitest";
import agent from "@agent/agent";
import browserAgent from "@agent/subagents/browser-agent/agent";
import { sessionUsageExceeded } from "../usage-limit";

function usage(tokens: {
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}) {
  const window = {
    cacheReadTokens: tokens.cacheReadTokens ?? 0,
    cacheWriteTokens: tokens.cacheWriteTokens ?? 0,
    inputTokens: tokens.inputTokens ?? 0,
    outputTokens: tokens.outputTokens ?? 0,
  };
  return { total: window, window };
}

describe("session usage limit", () => {
  it("pauses once the estimated Opus 5.5 spend since approval reaches $10", () => {
    // 2.5M uncached input tokens at $4 per million is $10.
    expect(sessionUsageExceeded(usage({ inputTokens: 2_499_999 }))).toBe(false);
    expect(sessionUsageExceeded(usage({ inputTokens: 2_500_000 }))).toBe(true);
    // Output costs five times as much: 500K output tokens is $10.
    expect(sessionUsageExceeded(usage({ outputTokens: 499_000 }))).toBe(false);
    expect(sessionUsageExceeded(usage({ outputTokens: 500_000 }))).toBe(true);
  });

  it("counts cache reads cheaply and cache writes above plain input", () => {
    // 40M cache reads at $0.20 per million is $8, so a long cached
    // conversation is not stopped by its replayed history alone.
    expect(
      sessionUsageExceeded(
        usage({ cacheReadTokens: 40_000_000, inputTokens: 40_000_000 })
      )
    ).toBe(false);
    // 2M cache writes at $5 per million is $10.
    expect(
      sessionUsageExceeded(
        usage({ cacheWriteTokens: 2_000_000, inputTokens: 2_000_000 })
      )
    ).toBe(true);
  });

  it("is the root agent's limit, which the browser worker inherits", () => {
    expect(agent.limits.sessionUsage).toBe(sessionUsageExceeded);
    expect("limits" in browserAgent).toBe(false);
  });
});
