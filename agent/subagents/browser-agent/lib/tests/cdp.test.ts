import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CdpConnection,
  type CdpEvent,
} from "@agent/subagents/browser-agent/lib/cdp";

const closedMessage = "The Kernel CDP connection closed.";
const written: string[] = [];
const sockets: KernelSocket[] = [];

// A WebSocket as Node's behaves: once closed, it drops what is sent on it
// without an error.
class KernelSocket extends EventTarget {
  #closed = false;

  constructor() {
    super();
    sockets.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }

  send(data: string) {
    if (this.#closed) return;
    written.push(
      z.object({ method: z.string() }).parse(JSON.parse(data)).method
    );
  }

  receive(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

async function connected() {
  const connection = await CdpConnection.connect("wss://kernel.test/cdp");
  const socket = sockets.at(-1);
  if (!socket) throw new Error("No socket was opened.");
  return { connection, socket };
}

beforeEach(() => {
  written.length = 0;
  sockets.length = 0;
  vi.stubGlobal("WebSocket", KernelSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("CdpConnection", () => {
  it("answers a command with its result", async () => {
    const { connection, socket } = await connected();

    const answer = connection.send("Target.getTargets");
    socket.receive(JSON.stringify({ id: 1, result: { targetInfos: [] } }));

    await expect(answer).resolves.toEqual({ targetInfos: [] });
    expect(connection.isOpen).toBe(true);
  });

  it("fails a pending command when the connection drops, and a later one at once without writing it", async () => {
    const { connection, socket } = await connected();
    const pending = connection.send("IO.read", { handle: "stream-1" });

    socket.close();

    await expect(pending).rejects.toThrow(closedMessage);
    await connection.closed;
    expect(connection.isOpen).toBe(false);
    const started = Date.now();
    await expect(
      connection.send("Target.closeTarget", { targetId: "tab-1" })
    ).rejects.toThrow(closedMessage);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(written).toEqual(["IO.read"]);
  });

  it("fails what is pending when it is closed here, and sends nothing after", async () => {
    const { connection } = await connected();
    const pending = connection.send("Page.navigate", { url: "about:blank" });

    connection.close();

    await expect(pending).rejects.toThrow(closedMessage);
    await expect(connection.send("Target.getTargets")).rejects.toThrow(
      closedMessage
    );
    expect(written).toEqual(["Page.navigate"]);
  });

  it("delivers events to a listener until it unsubscribes", async () => {
    const { connection, socket } = await connected();
    const events: CdpEvent[] = [];
    const unsubscribe = connection.onEvent((event) => {
      events.push(event);
    });

    socket.receive(
      JSON.stringify({
        method: "Fetch.requestPaused",
        params: { requestId: "request-1" },
        sessionId: "session-1",
      })
    );
    unsubscribe();
    socket.receive(
      JSON.stringify({ method: "Fetch.requestPaused", sessionId: "session-1" })
    );

    expect(events).toEqual([
      {
        method: "Fetch.requestPaused",
        params: { requestId: "request-1" },
        sessionId: "session-1",
      },
    ]);
  });
});
