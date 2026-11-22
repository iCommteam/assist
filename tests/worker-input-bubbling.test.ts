import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import browserAgent from "@agent/subagents/browser-agent/agent";

describe("worker input bubbling", () => {
  it("keeps native questions disabled inside browser workers", () => {
    expect(
      existsSync("agent/subagents/browser-agent/tools/ask_question.ts")
    ).toBe(false);
  });

  it("declares the browser worker statically on the direct Anthropic model", () => {
    // A dynamic subagent must return a serializable model id, so the worker is
    // static and run_browser decides which modes may use it.
    expect(browserAgent.tool).toBe(false);
    expect(browserAgent.model).toMatchObject({ modelId: "claude-opus-5-5" });
    expect(browserAgent.modelContextWindowTokens).toBe(1_000_000);
  });

  it("ends the worker turn and routes the answer through its task id", () => {
    const instructions = readFileSync(
      "agent/instructions/content/role/interactive.md",
      "utf8"
    );
    const workerInstructions = readFileSync(
      "agent/subagents/browser-agent/instructions.md",
      "utf8"
    );

    expect(instructions).toContain(
      "continue that worker with its `run_browser` `taskId`"
    );
    expect(instructions).toContain(
      "Before surfacing a `Needs user input:` blocker"
    );
    expect(instructions).toContain(
      "confirm the worker explicitly reported checking compatible vault items"
    );
    expect(workerInstructions).toContain(
      "Before returning `Needs user input:` or `Needs vault setup:`"
    );
    expect(workerInstructions).toContain("select the relevant compatible item");
    expect(workerInstructions).toContain(
      "structured completion tool Eve supplies"
    );
    expect(workerInstructions).toContain(
      "Follow the structured completion tool's instructions"
    );
  });
});
