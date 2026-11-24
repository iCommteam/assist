import type {
  AgentMessageResult,
  AgentResponse,
  AgentSendOptions,
  AgentSession,
  ToolContext,
  WorkflowServeCall,
  WorkflowServeContext,
} from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import runBrowser from "@agent/tools/run_browser";
import { toolContextFor } from "@tests/helpers/tool-context";

type WorkerMessage = Parameters<AgentSession["send"]>[0];
type CallAuth = ToolContext["session"]["auth"];

const completion = {
  status: "success",
  message: "Verified the page heading.",
  images: [],
};

const outputSchema = {
  type: "object",
  required: ["images", "status", "message"],
  properties: {
    images: { type: "array", maxItems: 4 },
    status: { enum: ["success", "failure"] },
  },
};

class ReceiveDrained extends Error {}

/**
 * Runs the serve loop over `calls` with a mocked worker session. The loop is
 * open-ended by design, so it ends when `receive()` has no more calls. Like
 * eve, the context takes each received call's auth, from `auths` by index.
 */
async function serveCalls(
  calls: readonly WorkflowServeCall<{ message: string }>[],
  results: readonly (AgentMessageResult | Error)[],
  auths: readonly CallAuth[] = []
) {
  const queue = [...calls];
  const authQueue = [...auths];
  const pending = [...results];
  const send = vi.fn<
    (
      message: WorkerMessage,
      options?: AgentSendOptions
    ) => Promise<AgentResponse>
  >(async () => {
    const next = pending.shift();
    if (!next) throw new Error("No worker result was scripted.");
    return {
      result: async () => {
        if (next instanceof Error) throw next;
        return next;
      },
    };
  });
  // SAFETY: The worker returns untyped JSON that run_browser parses itself, so
  // the mock's unparameterized output stands in for every requested TOutput.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- AgentSession.send is generic over the caller's output type.
  const session = { send } as AgentSession;
  const agent = vi.fn<WorkflowServeContext["agent"]>(() => session);
  const reply = vi.fn<WorkflowServeContext["reply"]>();
  const {
    abortSignal: _abortSignal,
    callId: _callId,
    ...shared
  } = toolContextFor();
  const mocks = { agent, reply, send };
  let auth = shared.session.auth;
  try {
    await runBrowser.serve(
      async () => {
        const call = queue.shift();
        if (!call) throw new ReceiveDrained();
        auth = authQueue.shift() ?? auth;
        return call;
      },
      {
        ...shared,
        session: {
          ...shared.session,
          get auth() {
            return auth;
          },
        },
        agent,
        agents: {},
        ask: vi.fn<WorkflowServeContext["ask"]>(),
        reply,
      }
    );
    return { ...mocks, error: undefined };
  } catch (error) {
    return { ...mocks, error };
  }
}

function serveCall(
  message: string,
  abortSignal = new AbortController().signal
): WorkflowServeCall<{ message: string }> {
  return { abortSignal, callId: `call-${message}`, input: { message } };
}

function completed(data: Partial<typeof completion>): AgentMessageResult {
  return { data, reply: "", sessionEnded: false, status: "completed" };
}

function callerAuth(authenticator: string): CallAuth {
  return {
    current: {
      attributes: { workspaceId: "personal:workspace" },
      authenticator,
      principalId: "user-1",
      principalType: "user",
    },
    initiator: null,
  };
}

const reportRefusal = {
  images: [],
  message: "Browser work is unavailable while reporting a scheduled result.",
  status: "failure",
};

describe("structured browser workflow", () => {
  it("supplies the completion schema on initial and continued calls to one worker", async () => {
    const { agent, error, reply, send } = await serveCalls(
      [serveCall("Inspect the heading"), serveCall("Inspect the footer")],
      [completed(completion), completed(completion)]
    );

    expect(error).toBeInstanceOf(ReceiveDrained);
    expect(agent).toHaveBeenCalledExactlyOnceWith("browser-agent");
    expect(send).toHaveBeenCalledTimes(2);
    for (const [index, message] of [
      "Inspect the heading",
      "Inspect the footer",
    ].entries()) {
      expect(send.mock.calls[index]).toMatchObject([message, { outputSchema }]);
    }
    expect(reply.mock.calls).toEqual([[completion], [completion]]);
  });

  it("rejects malformed completion instead of reporting success", async () => {
    const { error, reply } = await serveCalls(
      [serveCall("Inspect the heading")],
      [completed({ status: "success", message: "Done" })]
    );

    expect(error).not.toBeInstanceOf(ReceiveDrained);
    expect(String(error)).toMatch(/images/u);
    expect(reply).not.toHaveBeenCalled();
  });

  it("reports a failed worker turn as a structured failure", async () => {
    const { error, reply } = await serveCalls(
      [serveCall("Inspect the heading")],
      [
        {
          data: undefined,
          error: { message: "Kernel unavailable" },
          reply: "",
          sessionEnded: false,
          status: "failed",
        },
      ]
    );

    expect(error).toBeInstanceOf(ReceiveDrained);
    expect(reply).toHaveBeenCalledExactlyOnceWith({
      images: [],
      message: "Browser worker failed: Kernel unavailable",
      status: "failure",
    });
  });

  it("opens no worker for a scheduled result report", async () => {
    const { agent, error, reply, send } = await serveCalls(
      [serveCall("Inspect the heading")],
      [],
      [callerAuth("scheduled-result")]
    );

    expect(error).toBeInstanceOf(ReceiveDrained);
    expect(agent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledExactlyOnceWith(reportRefusal);
  });

  it("refuses a scheduled result report that continues an interactive task", async () => {
    const { error, reply, send } = await serveCalls(
      [serveCall("Inspect the heading"), serveCall("Inspect the footer")],
      [completed(completion)],
      [callerAuth("eve"), callerAuth("scheduled-result")]
    );

    expect(error).toBeInstanceOf(ReceiveDrained);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toMatchObject([
      "Inspect the heading",
      { outputSchema },
    ]);
    expect(reply.mock.calls).toEqual([[completion], [reportRefusal]]);
  });

  it("opens no worker for a site chat, which visits sites only through a look or a fetch", async () => {
    const chat = {
      attributes: {
        site: "teemiq",
        siteChat: "00000000-0000-4000-8000-0000000000c1",
        siteUser: "teemiq-user-1",
        workspaceId: "personal:workspace",
      },
      authenticator: "assist-site-chat",
      principalId: "user-1",
      principalType: "user",
    };
    const { agent, error, reply, send } = await serveCalls(
      [serveCall("Open the supplier's billing page")],
      [],
      [{ current: chat, initiator: chat }]
    );

    expect(error).toBeInstanceOf(ReceiveDrained);
    expect(agent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledExactlyOnceWith({
      images: [],
      message:
        "Browser work is unavailable in an Accounting chat. Visit a supplier's site only through an Accounting look or fetch.",
      status: "failure",
    });
  });

  it("serves scheduled workers", async () => {
    const { error, reply, send } = await serveCalls(
      [serveCall("Inspect the heading")],
      [completed(completion)],
      [callerAuth("scheduled-worker")]
    );

    expect(error).toBeInstanceOf(ReceiveDrained);
    expect(send).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledExactlyOnceWith(completion);
  });

  it("keeps the worker available after a cancelled stretch", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const { error, reply, send } = await serveCalls(
      [
        serveCall("Inspect the heading", cancelled.signal),
        serveCall("Inspect the footer"),
      ],
      [new Error("aborted"), completed(completion)]
    );

    expect(error).toBeInstanceOf(ReceiveDrained);
    expect(send).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledExactlyOnceWith(completion);
  });
});
