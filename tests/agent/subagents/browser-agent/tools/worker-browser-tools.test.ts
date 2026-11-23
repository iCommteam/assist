import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as WorkerAccess from "@agent/subagents/browser-agent/lib/access";
import * as OwnedBrowser from "@agent/subagents/browser-agent/lib/owned-browser";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import { resetEveState } from "@tests/helpers/eve-state";
import { toolContextFor } from "@tests/helpers/tool-context";
import computerAction from "@agent/subagents/browser-agent/tools/computer_action";
import {
  markCodeFilledBrowser,
  recordFilledDocuments,
} from "@agent/subagents/browser-agent/lib/autofill/redaction";

vi.mock("eve/context", () => import("@tests/helpers/eve-state"));

const clearPage = {
  frames: [],
  status: 200,
  text: "Example Domain",
  timeOrigin: 1_000,
  title: "Example Domain",
  url: "https://example.com/",
};

const mocks = {
  batch: vi.spyOn(kernel.browsers.computer, "batch"),
  captureScreenshot: vi.spyOn(kernel.browsers.computer, "captureScreenshot"),
  getMousePosition: vi.spyOn(kernel.browsers.computer, "getMousePosition"),
  playwright: vi.spyOn(kernel.browsers.playwright, "execute"),
  requireOwnedBrowserSession: vi.spyOn(
    OwnedBrowser,
    "requireOwnedBrowserSession"
  ),
  requireWorkerScope: vi.spyOn(WorkerAccess, "requireWorkerScope"),
};

beforeEach(() => {
  vi.clearAllMocks();
  resetEveState();
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    createdAt: "2026-08-31T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-session-1",
  });
  mocks.batch.mockResolvedValue();
  mocks.getMousePosition.mockResolvedValue({ x: 10, y: 20 });
  mocks.captureScreenshot.mockResolvedValue(new Response("png-bytes"));
  mocks.playwright.mockResolvedValue({ result: [clearPage], success: true });
});

describe("worker browser tools", () => {
  it("sends contiguous computer actions through Kernel batch at machine speed", async () => {
    const context = toolContextFor();
    const result = await computerAction.execute(
      {
        actions: [
          { click_mouse: { x: 10, y: 20 }, type: "click_mouse" },
          { move_mouse: { x: 30, y: 40 }, type: "move_mouse" },
          { type: "type_text", type_text: { text: "hello" } },
          { sleep: { duration_ms: 100 }, type: "sleep" },
          { type: "get_mouse_position" },
          {
            drag_mouse: {
              path: [
                [1, 2],
                [3, 4],
              ],
            },
            type: "drag_mouse",
          },
        ],
        session_id: "browser-1",
      },
      context
    );

    expect(mocks.batch).toHaveBeenCalledTimes(2);
    expect(mocks.batch).toHaveBeenNthCalledWith(
      1,
      "browser-1",
      {
        actions: [
          { click_mouse: { x: 10, y: 20 }, type: "click_mouse" },
          { move_mouse: { smooth: false, x: 30, y: 40 }, type: "move_mouse" },
          { type: "type_text", type_text: { delay: 0, text: "hello" } },
          { sleep: { duration_ms: 100 }, type: "sleep" },
        ],
      },
      { signal: context.abortSignal }
    );
    expect(mocks.batch).toHaveBeenNthCalledWith(
      2,
      "browser-1",
      {
        actions: [
          {
            drag_mouse: {
              delay: 0,
              path: [
                [1, 2],
                [3, 4],
              ],
              smooth: false,
              step_delay_ms: 0,
            },
            type: "drag_mouse",
          },
        ],
      },
      { signal: context.abortSignal }
    );
    expect(mocks.batch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getMousePosition.mock.invocationCallOrder[0] ?? Infinity
    );
    expect(result).toMatchObject({ data: [{ x: 10, y: 20 }] });
  });

  it("offers no clipboard, keystroke delay, drag timing or long sleep", () => {
    const schema = computerAction.inputSchema;
    if (!(schema instanceof z.ZodType)) {
      throw new Error("computer_action must use a Zod input schema.");
    }
    for (const action of [
      { type: "read_clipboard" },
      { type: "write_clipboard", write_clipboard: { text: "x" } },
      { sleep: { duration_ms: 2_001 }, type: "sleep" },
    ]) {
      expect(
        schema.safeParse({ actions: [action], session_id: "browser-1" }).success
      ).toBe(false);
    }
    // Unknown timing fields are stripped, never forwarded.
    const parsed = schema.parse({
      actions: [
        { type: "type_text", type_text: { delay: 250, text: "slow" } },
        {
          drag_mouse: {
            delay: 500,
            path: [
              [0, 0],
              [5, 5],
            ],
            step_delay_ms: 100,
            steps_per_segment: 30,
          },
          type: "drag_mouse",
        },
      ],
      session_id: "browser-1",
    });
    expect(JSON.stringify(parsed)).not.toMatch(
      /"delay":(?:250|500)|step_delay_ms|steps_per_segment/u
    );
  });

  it("drops the screenshot and stops the worker when the page is a CAPTCHA", async () => {
    mocks.playwright.mockResolvedValue({
      result: [
        {
          ...clearPage,
          text: "Please verify you are human to continue.",
        },
      ],
      success: true,
    });

    const result = await computerAction.execute(
      {
        actions: [
          { click_mouse: { x: 1, y: 1 }, type: "click_mouse" },
          { type: "screenshot" },
        ],
        session_id: "browser-1",
      },
      toolContextFor()
    );

    // Only the message: no screenshot and no data.
    const output = z.strictObject({ message: z.string() }).parse(result);
    expect(output.message).toContain("BLOCKED: example.com");
    await expect(
      computerAction.execute(
        { actions: [{ type: "screenshot" }], session_id: "browser-1" },
        toolContextFor()
      )
    ).rejects.toThrow(/already stopped at a block/u);
    expect(mocks.captureScreenshot).toHaveBeenCalledOnce();
  });

  it("withholds screenshots while the page holds a filled one-time code", async () => {
    markCodeFilledBrowser("browser-1");
    recordFilledDocuments("browser-1", [clearPage]);
    const screenshot = {
      actions: [{ type: "screenshot" as const }],
      session_id: "browser-1",
    };

    const withheld = await computerAction.execute(screenshot, toolContextFor());

    expect(withheld).toEqual({
      message:
        "Executed 1 computer action. The screenshot was withheld because this browser may still show a filled one-time code. Use browser_snapshot; screenshots return once the code page is gone.",
    });

    // Once the code page is replaced, screenshots come back.
    mocks.captureScreenshot.mockResolvedValueOnce(new Response("png-bytes"));
    mocks.playwright.mockResolvedValue({
      result: [{ ...clearPage, timeOrigin: 2_000 }],
      success: true,
    });
    const shown = await computerAction.execute(screenshot, toolContextFor());
    expect(shown).toMatchObject({ mimeType: "image/png" });
  });
});
