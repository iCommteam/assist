import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CallRequested,
  ContentCompleted,
  DeliveryConsumed,
  SessionView,
} from "eve/events";
import type { HookContext } from "eve/hooks";
import { z } from "zod";
import type {
  beginBrowserTrace,
  completeBrowserTrace,
  recordBrowserTraceEvents,
} from "@db/services/browser-traces";
import type { listWorkerBrowserSessions } from "@db/services/browsers";
import type * as TraceDomainsModule from "@agent/subagents/browser-agent/lib/trace/domains";
import type { harvestBrowserTraceDomains } from "@agent/subagents/browser-agent/lib/trace/domains";
import { domainFromUrl } from "@agent/subagents/browser-agent/lib/trace/domains";
import traceTelemetry from "@agent/subagents/browser-agent/hooks/trace-telemetry";
import { hookContextFor } from "@tests/helpers/hook-context";
import { viewOf } from "@tests/helpers/session-view";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { resetEveState } from "@tests/helpers/eve-state";
import {
  forgetInjectedValues,
  rememberInjectedValues,
} from "@agent/subagents/browser-agent/lib/autofill/redaction";

const mocks = vi.hoisted(() => ({
  beginBrowserTrace: vi.fn<typeof beginBrowserTrace>(),
  completeBrowserTrace: vi.fn<typeof completeBrowserTrace>(),
  harvestBrowserTraceDomains: vi.fn<typeof harvestBrowserTraceDomains>(),
  listWorkerBrowserSessions: vi.fn<typeof listWorkerBrowserSessions>(),
  recordBrowserTraceEvents: vi.fn<typeof recordBrowserTraceEvents>(),
}));

vi.mock("@db/services/browser-traces", () => ({
  beginBrowserTrace: mocks.beginBrowserTrace,
  completeBrowserTrace: mocks.completeBrowserTrace,
  recordBrowserTraceEvents: mocks.recordBrowserTraceEvents,
}));
vi.mock("eve/context", () => import("@tests/helpers/eve-state"));
vi.mock("@db/services/browsers", () => ({
  listWorkerBrowserSessions: mocks.listWorkerBrowserSessions,
}));
vi.mock(
  "@agent/subagents/browser-agent/lib/trace/domains",
  async (importOriginal) => ({
    ...(await importOriginal<typeof TraceDomainsModule>()),
    harvestBrowserTraceDomains: mocks.harvestBrowserTraceDomains,
  })
);

const scope = accessScopeForUser("better-auth:user-1");
const auth: HookContext["session"]["auth"] = {
  current: null,
  initiator: {
    attributes: { workspaceId: scope.workspaceId },
    authenticator: "test",
    principalId: scope.userId,
    principalType: "user",
  },
};

function contextAt(
  at: string,
  {
    position,
    view,
  }: { position?: HookContext["position"]; view?: SessionView } = {}
) {
  return hookContextFor({
    auth,
    now: new Date(at),
    position,
    sessionId: "worker-session-1",
    view,
  });
}

type TraceEvents = NonNullable<typeof traceTelemetry.events>;

async function fire<Type extends keyof TraceEvents>(
  type: Type,
  event: Parameters<NonNullable<TraceEvents[Type]>>[0],
  context: ReturnType<typeof contextAt>
) {
  const handler = traceTelemetry.events[type];
  expect(handler).toBeDefined();
  await handler?.(event, context);
}

function delivered(text: string): DeliveryConsumed {
  return {
    data: {
      deliveryId: "delivery-1",
      parts: [{ kind: "text", text }],
      turnId: "turn-1",
    },
    scope: { turnId: "turn-1" },
    type: "delivery.consumed",
  };
}

function resultContent(value: ContentCompleted["data"]["value"]) {
  return {
    data: {
      kind: "result",
      partId: "part-1",
      phase: "reply",
      runId: "run-1",
      value,
    },
    scope: { runId: "run-1", turnId: "turn-1" },
    type: "content.completed",
  } satisfies ContentCompleted;
}

function requested(
  callId: string,
  name: string,
  input: Readonly<Record<string, string>>
): CallRequested {
  return {
    data: {
      callId,
      capability: { kind: "tool", name },
      input,
      owner: { runId: "run-1" },
    },
    scope: { runId: "run-1", turnId: "turn-1" },
    type: "call.requested",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEveState();
  forgetInjectedValues("worker-session-1");
  mocks.beginBrowserTrace.mockResolvedValue();
  mocks.completeBrowserTrace.mockResolvedValue();
  mocks.harvestBrowserTraceDomains.mockResolvedValue();
  mocks.listWorkerBrowserSessions.mockResolvedValue([]);
  mocks.recordBrowserTraceEvents.mockResolvedValue();
});

describe("browser trace telemetry hook", () => {
  it("opens a running trace from the delegated task message", async () => {
    await fire(
      "delivery.consumed",
      delivered("Buy the blue mug on example.com"),
      contextAt("2026-08-31T00:00:00.000Z")
    );

    expect(mocks.beginBrowserTrace).toHaveBeenCalledExactlyOnceWith(scope, {
      sessionId: "worker-session-1",
      startedAt: "2026-08-31T00:00:00.000Z",
      task: "Buy the blue mug on example.com",
    });
  });

  it("records the structured completion outcome and sweeps live browsers", async () => {
    mocks.listWorkerBrowserSessions.mockResolvedValue([
      { createdAt: "2026-08-31T00:00:01.000Z", sessionId: "browser-1" },
    ]);

    await fire(
      "content.completed",
      resultContent({
        images: [],
        message: "Order placed.",
        status: "success",
      }),
      contextAt("2026-08-31T00:05:00.000Z")
    );

    expect(mocks.completeBrowserTrace).toHaveBeenCalledExactlyOnceWith(
      scope,
      "worker-session-1",
      {
        completedAt: "2026-08-31T00:05:00.000Z",
        resultMessage: "Order placed.",
        status: "success",
      }
    );
    expect(mocks.harvestBrowserTraceDomains).toHaveBeenCalledExactlyOnceWith(
      scope,
      "worker-session-1",
      { createdAt: "2026-08-31T00:00:01.000Z", sessionId: "browser-1" }
    );
  });

  it("ignores structured results that are not task completions", async () => {
    await fire(
      "content.completed",
      resultContent({ unrelated: true }),
      contextAt("2026-08-31T00:05:00.000Z")
    );
    await fire(
      "content.completed",
      {
        data: {
          kind: "text",
          partId: "part-2",
          phase: "reply",
          runId: "run-1",
          value: "Order placed.",
        },
        scope: { runId: "run-1", turnId: "turn-1" },
        type: "content.completed",
      },
      contextAt("2026-08-31T00:05:00.000Z")
    );

    expect(mocks.completeBrowserTrace).not.toHaveBeenCalled();
  });

  it("marks infrastructure failures and cancellations distinctly", async () => {
    await fire(
      "turn.settled",
      {
        data: {
          error: { code: "model_error", message: "The model call failed." },
          outcome: "failed",
          turnId: "turn-1",
        },
        scope: { turnId: "turn-1" },
        type: "turn.settled",
      },
      contextAt("2026-08-31T00:06:00.000Z")
    );
    await fire(
      "turn.settled",
      {
        data: { outcome: "cancelled", turnId: "turn-1" },
        scope: { turnId: "turn-1" },
        type: "turn.settled",
      },
      contextAt("2026-08-31T00:07:00.000Z")
    );
    await fire(
      "turn.settled",
      {
        data: { outcome: "completed", turnId: "turn-1" },
        scope: { turnId: "turn-1" },
        type: "turn.settled",
      },
      contextAt("2026-08-31T00:08:00.000Z")
    );

    expect(mocks.completeBrowserTrace).toHaveBeenCalledTimes(2);
    expect(mocks.completeBrowserTrace).toHaveBeenNthCalledWith(
      1,
      scope,
      "worker-session-1",
      {
        completedAt: "2026-08-31T00:06:00.000Z",
        resultMessage: "The model call failed.",
        status: "error",
      }
    );
    expect(mocks.completeBrowserTrace).toHaveBeenNthCalledWith(
      2,
      scope,
      "worker-session-1",
      {
        completedAt: "2026-08-31T00:07:00.000Z",
        resultMessage: undefined,
        status: "cancelled",
      }
    );
  });

  it("never throws telemetry failures back into the turn", async () => {
    mocks.beginBrowserTrace.mockRejectedValue(new Error("database offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      fire(
        "delivery.consumed",
        delivered("task"),
        contextAt("2026-08-31T00:00:00.000Z")
      )
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    // Only the error's name is logged, never its message or the row.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("database offline");
    warn.mockRestore();
  });

  it("keeps vault values out of stored rows, tasks and results", async () => {
    rememberInjectedValues("worker-session-1", "browser-1", [
      "correct-horse-battery",
    ]);

    await fire(
      "*",
      requested("call-1", "browser_snapshot", {
        note: 'value="correct-horse-battery" value="mugs"',
      }),
      contextAt("2026-08-31T00:00:02.000Z")
    );
    await fire(
      "delivery.consumed",
      delivered("Resume; the page showed correct-horse-battery"),
      contextAt("2026-08-31T00:00:03.000Z")
    );
    await fire(
      "content.completed",
      resultContent({
        images: [],
        message: "Signed in with correct-horse-battery",
        status: "success",
      }),
      contextAt("2026-08-31T00:05:00.000Z")
    );

    const stored = JSON.stringify([
      mocks.recordBrowserTraceEvents.mock.calls,
      mocks.beginBrowserTrace.mock.calls,
      mocks.completeBrowserTrace.mock.calls,
    ]);
    expect(stored).not.toContain("correct-horse-battery");
    // A filled document may still be open, so every rendered value is stripped.
    expect(stored).not.toContain("mugs");
  });
});

describe("trace event persistence", () => {
  it("summarizes stream events into single-line timeline rows", async () => {
    await fire(
      "*",
      requested("call-1", "manage_browsers", { session_id: "browser-1" }),
      contextAt("2026-08-31T00:00:02.000Z", {
        position: { index: 0, line: 4 },
      })
    );

    expect(mocks.recordBrowserTraceEvents).toHaveBeenCalledExactlyOnceWith(
      scope,
      "worker-session-1",
      [
        {
          at: "2026-08-31T00:00:02.000Z",
          detail: '{"session_id":"browser-1"}',
          id: "4:0",
          label: "manage_browsers",
          type: "call.requested",
        },
      ]
    );
  });

  it("labels durable workflow tool calls and skill loads in the trace", async () => {
    await fire(
      "*",
      requested("workflow-call", "check_availability", {}),
      contextAt("2026-08-31T00:00:02.000Z")
    );
    await fire(
      "*",
      {
        data: {
          callId: "skill-call",
          capability: { kind: "skill", name: "eve__skill" },
          input: { name: "checkout" },
          owner: { runId: "run-1" },
        },
        scope: { runId: "run-1", turnId: "turn-1" },
        type: "call.requested",
      },
      contextAt("2026-08-31T00:00:03.000Z")
    );

    expect(mocks.recordBrowserTraceEvents).toHaveBeenNthCalledWith(
      1,
      scope,
      "worker-session-1",
      [expect.objectContaining({ label: "check_availability" })]
    );
    expect(mocks.recordBrowserTraceEvents).toHaveBeenNthCalledWith(
      2,
      scope,
      "worker-session-1",
      [expect.objectContaining({ label: "Load skill" })]
    );
  });

  it("compacts oversized payloads before persisting", async () => {
    const view = viewOf([
      [requested("call-2", "computer_action", { action: "screenshot" })],
    ]);
    await fire(
      "*",
      {
        data: {
          callId: "call-2",
          outcome: "completed",
          output: { screenshotBase64: "x".repeat(50_000) },
        },
        scope: { runId: "run-1", turnId: "turn-1" },
        type: "call.settled",
      },
      contextAt("2026-08-31T00:00:03.000Z", { view })
    );

    const [, , events] = mocks.recordBrowserTraceEvents.mock.calls[0] ?? [];
    const detail = z
      .array(z.object({ detail: z.string(), label: z.string() }))
      .parse(events)[0];
    expect(detail?.label).toBe("computer_action → result");
    expect(detail?.detail.length).toBeLessThanOrEqual(601);
  });
});

describe("trace domain extraction", () => {
  it("keeps only http(s) hostnames", async () => {
    expect(domainFromUrl("https://shop.example.com/cart?item=1")).toBe(
      "shop.example.com"
    );
    expect(domainFromUrl("http://example.com")).toBe("example.com");
    expect(
      domainFromUrl("chrome-extension://abcdef/page.html")
    ).toBeUndefined();
    expect(domainFromUrl("about:blank")).toBeUndefined();
    expect(domainFromUrl("not a url")).toBeUndefined();
  });
});
