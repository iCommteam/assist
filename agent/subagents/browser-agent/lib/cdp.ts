import { z } from "zod";

export type CdpCommandValue =
  | boolean
  | number
  | string
  | null
  | undefined
  | readonly CdpCommandValue[]
  | { readonly [key: string]: CdpCommandValue };

const cdpValueSchema = z.json();

const cdpMessageSchema = z.object({
  error: z.object({ message: z.string() }).optional(),
  id: z.number().int().optional(),
  method: z.string().optional(),
  params: cdpValueSchema.optional(),
  result: cdpValueSchema.optional(),
  sessionId: z.string().optional(),
});

const commandTimeoutMs = 15_000;
const closedMessage = "The Kernel CDP connection closed.";

export interface CdpEvent {
  readonly method: string;
  readonly params: z.infer<typeof cdpValueSchema> | undefined;
  readonly sessionId: string | undefined;
}

// A connection to a Kernel browser's DevTools endpoint: commands, and the
// events Chromium sends to the listeners that subscribed.
export class CdpConnection {
  readonly #listeners = new Set<(event: CdpEvent) => void>();
  readonly #pending = new Map<
    number,
    {
      readonly reject: (cause?: unknown) => void;
      readonly resolve: (
        value: z.infer<typeof cdpValueSchema> | undefined
      ) => void;
    }
  >();
  #nextId = 1;
  // A closed socket drops what is sent on it without an error, so a command
  // sent once the connection has ended fails at once instead of waiting out
  // its timeout.
  #ended = false;
  readonly closed: Promise<void>;

  private constructor(
    private readonly socket: WebSocket,
    signal: AbortSignal | undefined
  ) {
    socket.addEventListener("message", (event) => {
      this.#onMessage(event);
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", () => {
        this.#end();
        resolve();
      });
    });
    signal?.addEventListener(
      "abort",
      () => {
        this.close();
      },
      { once: true }
    );
  }

  static async connect(url: string, signal?: AbortSignal) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not connect to the Kernel browser over CDP."));
      };
      const onAbort = () => {
        cleanup();
        socket.close();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("The CDP connection was aborted.")
        );
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return new CdpConnection(socket, signal);
  }

  send(
    method: string,
    params?: CdpCommandValue,
    sessionId?: string,
    timeoutMs = commandTimeoutMs
  ) {
    if (this.#ended) {
      return Promise.reject(new Error(closedMessage));
    }
    const id = this.#nextId++;
    return new Promise<z.infer<typeof cdpValueSchema> | undefined>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`Chromium did not respond to ${method}.`));
        }, timeoutMs);
        this.#pending.set(id, {
          reject(cause) {
            clearTimeout(timeout);
            reject(
              cause instanceof Error
                ? cause
                : new Error("The Chromium command failed.")
            );
          },
          resolve(value) {
            clearTimeout(timeout);
            resolve(value);
          },
        });
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      }
    );
  }

  // Returns the function that unsubscribes the listener.
  onEvent(listener: (event: CdpEvent) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get isOpen() {
    return !this.#ended;
  }

  close() {
    if (this.#ended) return;
    this.#end();
    this.socket.close();
  }

  #end() {
    this.#ended = true;
    this.#rejectPending(new Error(closedMessage));
  }

  #onMessage(event: MessageEvent) {
    const eventData = z.string().safeParse(event.data);
    if (!eventData.success) return;
    let rawMessage: z.infer<typeof cdpValueSchema>;
    try {
      const parsed = cdpValueSchema.safeParse(JSON.parse(eventData.data));
      if (!parsed.success) return;
      rawMessage = parsed.data;
    } catch {
      return;
    }
    const message = cdpMessageSchema.safeParse(rawMessage);
    if (!message.success) return;
    const { error, id, method, params, result, sessionId } = message.data;
    if (id === undefined) {
      if (method === undefined) return;
      for (const listener of this.#listeners) {
        listener({ method, params, sessionId });
      }
      return;
    }
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (error) {
      pending.reject(new Error(error.message));
    } else {
      pending.resolve(result);
    }
  }

  #rejectPending(error: Error) {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }
}
