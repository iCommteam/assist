import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import rootAgent from "@agent/agent";

const rootTools = "agent/tools";
const workerRoot = "agent/subagents/browser-agent";
const workerTools = `${workerRoot}/tools`;

function toolFiles(directory: string, root = directory): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return toolFiles(path, root);
      return entry.name.endsWith(".ts") ? path.slice(root.length + 1) : [];
    })
    .toSorted();
}

describe("root and worker capability boundaries", () => {
  it("keeps root coordination separate from browser execution", () => {
    expect(rootAgent.defaultTools).toBe(false);
    expect(toolFiles(rootTools)).toEqual([
      "ask_question.ts",
      "calendar.ts",
      "drive.ts",
      "gmail.ts",
      "messaging.ts",
      "run_browser.ts",
      "schedules.ts",
      "site_task.ts",
      "vault.ts",
      "web_search.ts",
    ]);
    // With defaultTools off, eve's web_fetch exists only if a file adds it back.
    expect(existsSync(`${rootTools}/web_fetch.ts`)).toBe(false);
    expect(existsSync(`${rootTools}/sendMessage.ts`)).toBe(false);
    // Eve's built-in `eve__task_cancel` replaces the authored cancel tool.
    expect(existsSync(`${rootTools}/task_cancel.ts`)).toBe(false);
    expect(existsSync("agent/extensions/kernel/extension.ts")).toBe(false);
    expect(existsSync("agent/extensions/kernel/connections/browser.ts")).toBe(
      false
    );
    expect(existsSync("agent/skills/browser-execution/SKILL.md")).toBe(false);
    const rootInstructions = readFileSync(
      "agent/instructions/content/role/interactive.md",
      "utf8"
    );
    expect(rootInstructions).toContain(
      "Perform public research, source discovery, comparisons, and current-information lookups directly with `web_search`"
    );
    expect(rootInstructions).not.toContain("web_fetch");
  });

  it("keeps no file memory, which needs Vercel Blob", () => {
    expect(readdirSync("agent/memory").toSorted()).toEqual([
      "personal_info.ts",
      "workstreams.ts",
    ]);
  });

  it("gives worker the browser and opaque-vault tools without messaging", () => {
    expect(toolFiles(workerTools)).toEqual([
      "bash.ts",
      "computer_action.ts",
      "fill_code_from_site.ts",
      "fill_from_vault.ts",
      "fill_totp_from_vault.ts",
      "list_vault.ts",
      "manage_browsers.ts",
      "personal_info.ts",
      "read_file.ts",
      "save_file.ts",
      "semantic_browser.ts",
      "web_fetch.ts",
      "web_search.ts",
      "write_file.ts",
    ]);
    // Only a pinned site task's worker sees it, and it fetches through Kernel.
    const saveFile = readFileSync(`${workerTools}/save_file.ts`, "utf8");
    expect(saveFile).toContain("defineDynamic(");
    expect(saveFile).toContain(
      "siteLoginOfSession(context.session.auth.initiator)"
    );
    expect(saveFile).toContain("requireWorkerScope(context)");
    expect(saveFile).toContain(
      'from "@agent/subagents/browser-agent/lib/kernel"'
    );
    expect(saveFile).not.toContain("new Kernel(");
    expect(existsSync(`${workerRoot}/tools/sendMessage.ts`)).toBe(false);
    expect(existsSync(`${workerRoot}/tools/request_vault_setup.ts`)).toBe(
      false
    );
    expect(existsSync(`${workerTools}/ask_question.ts`)).toBe(false);
    expect(readFileSync(`${workerTools}/personal_info.ts`, "utf8")).toContain(
      "disableTool()"
    );
    // Skills load through Eve's built-in `eve__skill`, not an authored tool.
    expect(existsSync(`${workerTools}/load_skill.ts`)).toBe(false);
    for (const tool of [
      "bash",
      "read_file",
      "web_fetch",
      "web_search",
      "write_file",
    ]) {
      expect(readFileSync(`${workerTools}/${tool}.ts`, "utf8")).toContain(
        "disableTool()"
      );
    }
    expect(existsSync(`${workerRoot}/extensions/kernel/extension.ts`)).toBe(
      false
    );
    expect(readFileSync("package.json", "utf8")).not.toContain(
      "@onkernel/eve-extension"
    );
    for (const tool of ["computer_action", "manage_browsers"]) {
      const source = readFileSync(`${workerTools}/${tool}.ts`, "utf8");
      expect(source).toContain("defineTool(");
      expect(source).not.toContain("defineDynamic(");
      expect(source).toContain("requireWorkerScope(context)");
    }
    expect(existsSync(`${workerRoot}/hooks/session-owner.ts`)).toBe(true);
    expect(existsSync(`${workerRoot}/skills/browser-execution/SKILL.md`)).toBe(
      false
    );
    const semanticBrowser = readFileSync(
      `${workerTools}/semantic_browser.ts`,
      "utf8"
    );
    expect(semanticBrowser).toContain("defineDynamic(");
    expect(semanticBrowser).toContain("requireWorkerScope(context)");
    expect(semanticBrowser).toContain('from "@onkernel/browser-loop"');
    const workerInstructions = readFileSync(
      `${workerRoot}/instructions.md`,
      "utf8"
    );
    expect(workerInstructions).not.toContain("`inspect_autofill`");
    expect(workerInstructions).not.toContain("`final_output`");
    expect(workerInstructions).toContain(
      "structured completion tool Eve supplies"
    );
    expect(workerInstructions).toContain(
      "Never use the browser for general web search"
    );
    expect(workerInstructions).toContain(
      "A named vertical search or booking product"
    );
    expect(workerInstructions).toContain("such as Google Flights");
    expect(workerInstructions).toContain(
      "`browser_act` dispatches actions and returns the successor state"
    );
    // No model-written Playwright, no solver, no live-view URL in chat.
    expect(workerInstructions).not.toMatch(/playwright|stealth|live.view/iu);
    expect(semanticBrowser).not.toContain("loop.tools.playwright");
    expect(workerInstructions).toContain(
      "answer truthfully that you are an automated AI agent (iCommAssist)"
    );
    expect(workerInstructions).toContain(
      "Never claim or imply that you are a human"
    );
    expect(workerInstructions).toContain(
      "Never imitate human typing, mouse movement, or navigation speed"
    );
    expect(workerInstructions).toContain(
      "Amazon sites are blocked by policy for now"
    );
    expect(workerInstructions).toContain(
      "Never wait for it to clear or for a solver"
    );
    expect(workerInstructions).toContain("The vault fills saved logins only.");
    expect(workerInstructions).toContain(
      "never ask the coordinator for a code the vault can produce"
    );
    expect(existsSync(`${workerRoot}/lib/browser-contract.ts`)).toBe(false);
    expect(existsSync(`${workerRoot}/lib/browser-runtime.ts`)).toBe(false);
    expect(existsSync(`${workerRoot}/lib/owned-browser.ts`)).toBe(true);

    expect(readFileSync(`${workerRoot}/lib/kernel.ts`, "utf8")).toContain(
      "new Kernel("
    );
    for (const tool of ["computer_action", "manage_browsers"]) {
      const source = readFileSync(`${workerTools}/${tool}.ts`, "utf8");
      expect(source).toContain(
        'from "@agent/subagents/browser-agent/lib/kernel"'
      );
      expect(source).not.toContain("new Kernel(");
    }
    for (const tool of ["fill_from_vault", "fill_totp_from_vault"]) {
      expect(readFileSync(`${workerTools}/${tool}.ts`, "utf8")).toContain(
        'from "../lib/autofill/native"'
      );
    }
    // The only worker tool that asks anyone anything. Its workflow body may
    // not reach a Node.js module, so its steps load the browser and vault code.
    const codeTool = readFileSync(
      `${workerTools}/fill_code_from_site.ts`,
      "utf8"
    );
    expect(codeTool).toContain("defineWorkflowTool(");
    expect(codeTool).not.toMatch(/from "@(?:db|agent)\//u);
    expect(codeTool).toContain(
      'await import("@agent/subagents/browser-agent/lib/autofill/site-code")'
    );
  });

  it("requires structured completion for initial and resumed worker calls", () => {
    const workerCoordination = readFileSync(
      "agent/instructions/content/worker-coordination.md",
      "utf8"
    );
    const workerConfig = readFileSync(`${workerRoot}/agent.ts`, "utf8");

    expect(workerCoordination).toContain(
      "tool supplies the required structured completion schema"
    );
    expect(workerCoordination).toContain(
      "including when passing an existing `taskId`"
    );
    expect(workerCoordination).toContain(
      "using the completion tool Eve supplies"
    );
    expect(workerConfig).toContain("tool: false");
    expect(workerConfig).not.toContain("outputSchema:");
  });
});
