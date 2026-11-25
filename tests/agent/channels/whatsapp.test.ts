import { createHmac } from "node:crypto";
import type {
  ChannelEventContext,
  ChannelFrom,
  ChannelResolveSession,
  ChannelSource,
  RouteHandlerArgs,
} from "eve/channels";
import type {
  TwilioChannelConfig,
  TwilioChannelState,
  TwilioEventContext,
  TwilioHandle,
} from "eve/channels/twilio";
import { SessionNotActiveError } from "eve/client";
import type { CallSettled, Fact } from "eve/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { enrolledTeamMemberId } from "@db/services/auth/allowlist";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { viewOf } from "@tests/helpers/session-view";

// Test fixtures only: a fake account, token and numbers.
const accountSid = `AC${"0".repeat(32)}`;
const authToken = "test-twilio-auth-token-0123456789";
const companyNumber = "whatsapp:+15550000000";
const memberNumber = "+15550000001";
const publicOrigin = "https://assist.example.test";
// Where Next hands the webhook to eve: not the URL Twilio signed.
const loopbackOrigin = "http://127.0.0.1:4274";
const messagesPath = "/eve/v1/whatsapp/messages";

// What the mocked environment reads; undefined is unset.
interface TestConfig {
  accountSid: string | undefined;
  authToken: string | undefined;
  from: string | undefined;
  numbers: string;
}

const mocks = vi.hoisted(() => {
  const config: TestConfig = {
    accountSid: undefined,
    authToken: undefined,
    from: undefined,
    numbers: "",
  };
  return {
    config,
    enrolledTeamMemberId: vi.fn<typeof enrolledTeamMemberId>(),
    // SAFETY: The mocked channel factory replaces this value during module loading.
    twilioConfig: undefined as TwilioChannelConfig | undefined,
  };
});

vi.mock("@shared/environment", () => ({
  env: {
    get TWILIO_ACCOUNT_SID() {
      return mocks.config.accountSid;
    },
    get TWILIO_AUTH_TOKEN() {
      return mocks.config.authToken;
    },
    get TWILIO_WHATSAPP_FROM() {
      return mocks.config.from;
    },
  },
  whatsappNumbersVariable: () => mocks.config.numbers,
}));
vi.mock("@shared/environment/origin", () => ({
  applicationOrigin: () => publicOrigin,
}));
vi.mock("@db/services/auth/allowlist", () => ({
  enrolledTeamMemberId: mocks.enrolledTeamMemberId,
}));
vi.mock(import("eve/channels/twilio"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    twilioChannel(config: TwilioChannelConfig) {
      mocks.twilioConfig = config;
      return original.twilioChannel(config);
    },
  };
});

const { default: whatsapp } = await import("@agent/channels/whatsapp");

const twilioCalls: { body: URLSearchParams; url: string }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  twilioCalls.length = 0;
  Object.assign(mocks.config, {
    accountSid,
    authToken,
    from: companyNumber,
    numbers: `${memberNumber}=Member@Example.test, +15550000009=other@example.test`,
  });
  mocks.enrolledTeamMemberId.mockImplementation(async (email) =>
    email === "member@example.test" ? "user-1" : undefined
  );
  // Twilio's API, faked: nothing reaches the network.
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.startsWith("https://api.twilio.com/")) {
        throw new Error(`Unexpected request to ${url}`);
      }
      twilioCalls.push({
        body:
          init?.body instanceof URLSearchParams
            ? init.body
            : new URLSearchParams(),
        url,
      });
      return Response.json({ sid: "SM-sent" }, { status: 201 });
    })
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let nextMessage = 0;

function messageParams(
  overrides: Partial<Record<"Body" | "From" | "MessageSid" | "To", string>> = {}
) {
  nextMessage += 1;
  return {
    AccountSid: accountSid,
    Body: "Which suppliers did we pay twice this month?",
    From: `whatsapp:${memberNumber}`,
    MessageSid: `SM${String(nextMessage).padStart(32, "0")}`,
    NumMedia: "0",
    To: companyNumber,
    ...overrides,
  };
}

// The principal a listed member's messages run as.
const memberPrincipal = {
  attributes: {
    conversationChannel: "whatsapp",
    email: "member@example.test",
    workspaceId: accessScopeForUser("better-auth:user-1").workspaceId,
  },
  authenticator: "assist-whatsapp",
  principalId: "better-auth:user-1",
  principalType: "user",
};

// Twilio's signature: HMAC-SHA1 over the URL it called and the sorted
// parameters, keyed with the account's auth token.
function signature(
  url: string,
  params: Readonly<Record<string, string>>,
  token: string
) {
  const signed = Object.keys(params)
    .toSorted()
    .reduce((base, key) => `${base}${key}${params[key] ?? ""}`, url);
  return createHmac("sha1", token).update(signed).digest("base64");
}

function webhook(
  params: Readonly<Record<string, string>>,
  {
    path = messagesPath,
    signedFor = `${publicOrigin}${path}`,
    token = authToken,
  }: { path?: string; signedFor?: string; token?: string } = {}
) {
  return new Request(`${loopbackOrigin}${path}`, {
    body: new URLSearchParams(params).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature(signedFor, params, token),
    },
    method: "POST",
  });
}

type Delivery = Awaited<ReturnType<ChannelSource<TwilioChannelState>["send"]>>;

function fakeDelivery(): Delivery {
  return {
    deliveryId: "delivery-1",
    result: vi.fn<Delivery["result"]>(),
    sessionId: "session-1",
    stream: vi.fn<Delivery["stream"]>(),
  };
}

type ChatSession = NonNullable<Awaited<ReturnType<ChannelResolveSession>>>;

// A session whose last recorded line is at `at`.
function sessionLastActiveAt(at: string): ChatSession {
  const lastLine: Fact = {
    data: { outcome: "completed", turnId: "turn-1" },
    scope: { turnId: "turn-1" },
    type: "turn.settled",
  };
  return {
    cancel: vi.fn<ChatSession["cancel"]>(),
    clear: vi.fn<ChatSession["clear"]>(),
    compact: vi.fn<ChatSession["compact"]>(),
    end: vi.fn<ChatSession["end"]>(),
    id: "session-1",
    prewarm: vi.fn<ChatSession["prewarm"]>(),
    respond: vi.fn<ChatSession["respond"]>(),
    send: vi.fn<ChatSession["send"]>(),
    async *stream() {
      yield { ...lastLine, meta: { at, position: { index: 0, line: 0 } } };
    },
  };
}

// The route's operations, faked: one chat address, and the background work
// the route hands off.
function routeHarness(session?: ChatSession) {
  const tasks: Promise<unknown>[] = [];
  const source = {
    cancel: vi.fn<ChannelSource<TwilioChannelState>["cancel"]>(),
    clear: vi.fn<ChannelSource<TwilioChannelState>["clear"]>(),
    compact: vi.fn<ChannelSource<TwilioChannelState>["compact"]>(),
    create: vi.fn<ChannelSource<TwilioChannelState>["create"]>(),
    end: vi.fn<ChannelSource<TwilioChannelState>["end"]>(async () =>
      fakeDelivery()
    ),
    respond: vi.fn<ChannelSource<TwilioChannelState>["respond"]>(),
    send: vi.fn<ChannelSource<TwilioChannelState>["send"]>(async () =>
      fakeDelivery()
    ),
  } satisfies ChannelSource<TwilioChannelState>;
  // What reached each chat address, in order.
  const operations: { address: string; operation: "end" | "send" }[] = [];
  const from = vi.fn<ChannelFrom<TwilioChannelState>>((address) => ({
    ...source,
    async end(options) {
      operations.push({ address, operation: "end" });
      return source.end(options);
    },
    async send(message, options) {
      operations.push({ address, operation: "send" });
      return source.send(message, options);
    },
  }));
  const resolveSession = vi.fn<ChannelResolveSession>(async () => session);
  const args = {
    attachSession:
      vi.fn<RouteHandlerArgs<TwilioChannelState>["attachSession"]>(),
    describe: vi.fn<RouteHandlerArgs<TwilioChannelState>["describe"]>(),
    from,
    invokeTool: vi.fn<RouteHandlerArgs<TwilioChannelState>["invokeTool"]>(),
    listSkillFiles:
      vi.fn<RouteHandlerArgs<TwilioChannelState>["listSkillFiles"]>(),
    params: {},
    readSkill: vi.fn<RouteHandlerArgs<TwilioChannelState>["readSkill"]>(),
    requestIp: null,
    resolveSession,
    to: vi.fn<RouteHandlerArgs<TwilioChannelState>["to"]>(),
    waitUntil(task: Promise<unknown>) {
      tasks.push(task);
    },
  } satisfies RouteHandlerArgs<TwilioChannelState>;
  return {
    from,
    operations,
    resolveSession,
    source,
    async post(request: Request, path = messagesPath) {
      const route = whatsapp.routes.find(
        (definition) => definition.path === path && definition.method === "POST"
      );
      if (!route || route.transport === "websocket") {
        throw new Error(`No HTTP route at ${path}.`);
      }
      const response = await route.handler(request, args);
      await Promise.all(tasks);
      return response;
    },
  };
}

function sentBodies() {
  return twilioCalls.map(({ body }) => ({
    Body: body.get("Body"),
    From: body.get("From"),
    MediaUrl: body.get("MediaUrl"),
    To: body.get("To"),
  }));
}

describe("WhatsApp webhook", () => {
  it.each(["accountSid", "authToken", "from"] as const)(
    "refuses every webhook while %s is unset",
    async (unset) => {
      mocks.config[unset] = undefined;
      const harness = routeHarness();

      const response = await harness.post(webhook(messageParams()));

      expect(response.status).toBe(403);
      expect(harness.from).not.toHaveBeenCalled();
      expect(mocks.enrolledTeamMemberId).not.toHaveBeenCalled();
    }
  );

  it("refuses a webhook signed with another token, or for the loopback URL eve sees", async () => {
    const harness = routeHarness();
    const params = messageParams();

    const forged = await harness.post(
      webhook(params, { token: "another-token-0123456789abcdef" })
    );
    const loopback = await harness.post(
      webhook(params, { signedFor: `${loopbackOrigin}${messagesPath}` })
    );

    expect(forged.status).toBe(401);
    expect(loopback.status).toBe(401);
    expect(harness.from).not.toHaveBeenCalled();
  });

  it("accepts a webhook signed for the public URL and admits a listed member as their assist user", async () => {
    const harness = routeHarness();

    const response = await harness.post(webhook(messageParams()));

    expect(response.status).toBe(200);
    expect(mocks.enrolledTeamMemberId).toHaveBeenCalledExactlyOnceWith(
      "member@example.test"
    );
    expect(harness.operations).toEqual([
      {
        address: `whatsapp:${memberNumber}:${companyNumber}|better-auth:user-1`,
        operation: "send",
      },
    ]);
    expect(harness.source.send).toHaveBeenCalledExactlyOnceWith(
      "Which suppliers did we pay twice this month?",
      expect.objectContaining({ auth: memberPrincipal })
    );
  });

  it.each([
    ["an unknown number", { From: "whatsapp:+15550000002" }],
    ["an SMS from a listed number", { From: memberNumber }],
    ["a message to another number", { To: "whatsapp:+15550000003" }],
  ])("answers %s with an empty reply and nothing else", async (_case, from) => {
    const harness = routeHarness();

    const response = await harness.post(webhook(messageParams(from)));

    expect(response.status).toBe(200);
    expect(await response.text()).not.toMatch(/<Message|<Say/u);
    expect(harness.from).not.toHaveBeenCalled();
    expect(mocks.enrolledTeamMemberId).not.toHaveBeenCalled();
    expect(twilioCalls).toEqual([]);
  });

  it("ignores a listed member who could not sign in to assist", async () => {
    mocks.enrolledTeamMemberId.mockResolvedValue(undefined);
    const harness = routeHarness();

    const response = await harness.post(webhook(messageParams()));

    expect(response.status).toBe(200);
    expect(harness.from).not.toHaveBeenCalled();
  });

  it("never counts or answers a listed number whose member cannot sign in, even past the limit", async () => {
    const unenrolled = "+15550000006";
    mocks.config.numbers = `${unenrolled}=unenrolled@example.test`;
    const harness = routeHarness();
    const fromUnenrolled = () =>
      harness.post(webhook(messageParams({ From: `whatsapp:${unenrolled}` })));

    for (let sent = 0; sent < 31; sent += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The webhooks arrive one after another.
      await fromUnenrolled();
    }

    expect(twilioCalls).toEqual([]);
    expect(harness.from).not.toHaveBeenCalled();

    // Enrolled later, the member has the whole hour's messages.
    mocks.enrolledTeamMemberId.mockResolvedValue("user-3");
    for (let sent = 0; sent < 30; sent += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The webhooks arrive one after another.
      await fromUnenrolled();
    }

    expect(harness.source.send).toHaveBeenCalledTimes(30);
    expect(twilioCalls).toEqual([]);
  });

  it("reaches nobody through a number listed for two emails, or an entry that does not parse", async () => {
    mocks.config.numbers = `${memberNumber}=member@example.test,${memberNumber}=other@example.test,+15550000004=not-an-email`;
    const harness = routeHarness();

    await harness.post(webhook(messageParams()));
    await harness.post(
      webhook(messageParams({ From: "whatsapp:+15550000004" }))
    );

    expect(harness.from).not.toHaveBeenCalled();
  });

  it("reads the members on every webhook", async () => {
    const harness = routeHarness();
    mocks.config.numbers = "";
    await harness.post(webhook(messageParams()));
    mocks.config.numbers = `${memberNumber}=member@example.test`;
    await harness.post(webhook(messageParams()));

    expect(harness.source.send).toHaveBeenCalledOnce();
  });

  it("passes each message id to the agent once", async () => {
    const harness = routeHarness();
    const params = messageParams();

    await harness.post(webhook(params));
    await harness.post(webhook(params));

    expect(harness.source.send).toHaveBeenCalledOnce();
  });

  it("rejects calls and their transcripts", async () => {
    const harness = routeHarness();
    const call = {
      AccountSid: accountSid,
      CallSid: `CA${"1".repeat(32)}`,
      From: `whatsapp:${memberNumber}`,
      To: companyNumber,
    };

    const response = await harness.post(
      webhook(call, { path: "/eve/v1/whatsapp/voice" }),
      "/eve/v1/whatsapp/voice"
    );
    await harness.post(
      webhook(
        { ...call, Confidence: "0.9", SpeechResult: "Pay every invoice." },
        { path: "/eve/v1/whatsapp/voice/transcription" }
      ),
      "/eve/v1/whatsapp/voice/transcription"
    );

    expect(response.status).toBe(403);
    expect(harness.from).not.toHaveBeenCalled();
    expect(mocks.enrolledTeamMemberId).not.toHaveBeenCalled();
  });
});

describe("WhatsApp chats", () => {
  it("ends the chat on /new, confirms it, and passes nothing to the agent", async () => {
    const harness = routeHarness(sessionLastActiveAt(new Date().toISOString()));

    await harness.post(webhook(messageParams({ Body: " /New " })));

    expect(harness.source.end).toHaveBeenCalledOnce();
    expect(harness.source.send).not.toHaveBeenCalled();
    expect(sentBodies()).toEqual([
      {
        Body: "Started a new chat. What can I help with?",
        From: companyNumber,
        MediaUrl: null,
        To: `whatsapp:${memberNumber}`,
      },
    ]);
    expect(twilioCalls[0]?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`
    );

    await harness.post(webhook(messageParams({ Body: "Hello again" })));

    expect(harness.source.end).toHaveBeenCalledOnce();
    expect(harness.source.send).toHaveBeenCalledExactlyOnceWith(
      "Hello again",
      expect.anything()
    );
  });

  it("starts a new chat for a message more than 8 hours after the last activity", async () => {
    const stale = routeHarness(
      sessionLastActiveAt(
        new Date(Date.now() - 8 * 60 * 60_000 - 60_000).toISOString()
      )
    );
    await stale.post(webhook(messageParams()));

    expect(stale.source.end).toHaveBeenCalledOnce();
    expect(stale.source.send).toHaveBeenCalledOnce();
    expect(stale.source.end.mock.invocationCallOrder[0]).toBeLessThan(
      stale.source.send.mock.invocationCallOrder[0] ?? 0
    );

    const recent = routeHarness(
      sessionLastActiveAt(new Date(Date.now() - 7 * 60 * 60_000).toISOString())
    );
    await recent.post(webhook(messageParams()));

    expect(recent.source.end).not.toHaveBeenCalled();
    expect(recent.source.send).toHaveBeenCalledOnce();
  });

  it("confirms /new when no chat is open, for a first message or a second /new", async () => {
    const harness = routeHarness();
    harness.source.end.mockRejectedValue(new SessionNotActiveError());

    await harness.post(webhook(messageParams({ Body: "/new" })));
    await harness.post(webhook(messageParams({ Body: "/new" })));

    expect(harness.source.end).toHaveBeenCalledTimes(2);
    expect(harness.source.send).not.toHaveBeenCalled();
    expect(sentBodies().map(({ Body }) => Body)).toEqual([
      "Started a new chat. What can I help with?",
      "Started a new chat. What can I help with?",
    ]);
  });

  it("says nothing of a new chat when the open one could not be ended", async () => {
    const harness = routeHarness(sessionLastActiveAt(new Date().toISOString()));
    harness.source.end.mockRejectedValue(
      new Error("The runtime is unreachable.")
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await harness.post(webhook(messageParams({ Body: "/new" })));

    expect(harness.source.end).toHaveBeenCalledOnce();
    expect(twilioCalls).toEqual([]);
    expect(harness.source.send).not.toHaveBeenCalled();
  });

  it("starts a new chat for a message after a long silence when the idle chat stopped first", async () => {
    const harness = routeHarness(
      sessionLastActiveAt(
        new Date(Date.now() - 8 * 60 * 60_000 - 60_000).toISOString()
      )
    );
    harness.source.end.mockRejectedValue(new SessionNotActiveError());

    await harness.post(webhook(messageParams()));

    expect(harness.source.end).toHaveBeenCalledOnce();
    expect(harness.source.send).toHaveBeenCalledOnce();
  });

  it("starts the new member's own chat when their number was listed for someone else", async () => {
    const number = "+15550000010";
    const chatOf = (userId: string) =>
      `whatsapp:${number}:${companyNumber}|better-auth:${userId}`;
    const users = new Map([
      ["member@example.test", "user-1"],
      ["other@example.test", "user-2"],
    ]);
    mocks.enrolledTeamMemberId.mockImplementation(async (email) =>
      users.get(email)
    );
    const harness = routeHarness();
    harness.resolveSession.mockImplementation(async (address) =>
      address === chatOf("user-1")
        ? sessionLastActiveAt(new Date().toISOString())
        : undefined
    );
    const fromNumber = () =>
      harness.post(webhook(messageParams({ From: `whatsapp:${number}` })));

    mocks.config.numbers = `${number}=member@example.test`;
    await fromNumber();
    mocks.config.numbers = `${number}=other@example.test`;
    await fromNumber();

    expect(harness.operations).toEqual([
      { address: chatOf("user-1"), operation: "send" },
      { address: chatOf("user-2"), operation: "send" },
    ]);
    expect(
      harness.source.send.mock.calls.map(([, options]) => options.auth)
    ).toEqual([
      expect.objectContaining({ principalId: "better-auth:user-1" }),
      expect.objectContaining({ principalId: "better-auth:user-2" }),
    ]);
  });

  it("passes a sender's messages on in the order they arrived, when a later one is admitted first", async () => {
    const sender = "+15550000008";
    mocks.config.numbers = `${sender}=member@example.test`;
    const lookups: ((userId: string | undefined) => void)[] = [];
    mocks.enrolledTeamMemberId.mockImplementation(
      async () =>
        new Promise((resolve) => {
          lookups.push(resolve);
        })
    );
    const harness = routeHarness(sessionLastActiveAt(new Date().toISOString()));
    const fromSender = (Body: string) =>
      harness.post(
        webhook(messageParams({ Body, From: `whatsapp:${sender}` }))
      );

    const newChat = fromSender("/new");
    await vi.waitFor(() => {
      expect(lookups).toHaveLength(1);
    });
    const payList = fromSender("Pay list for March");
    await vi.waitFor(() => {
      expect(lookups).toHaveLength(2);
    });
    lookups[1]?.("user-1");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.operations).toEqual([]);

    lookups[0]?.("user-1");
    await Promise.all([newChat, payList]);

    expect(harness.operations.map(({ operation }) => operation)).toEqual([
      "end",
      "send",
    ]);
    expect(harness.source.send).toHaveBeenCalledExactlyOnceWith(
      "Pay list for March",
      expect.anything()
    );
    expect(sentBodies().map(({ Body }) => Body)).toEqual([
      "Started a new chat. What can I help with?",
    ]);
  });

  it("holds a sender's next message for 10 seconds at most behind one that never reached its chat", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sender = "+15550000007";
    mocks.config.numbers = `${sender}=member@example.test`;
    const harness = routeHarness();

    // A media address eve cannot read: admitted, the message never reaches
    // its chat.
    await harness.post(
      webhook({
        ...messageParams({ From: `whatsapp:${sender}` }),
        MediaUrl0: "not a URL",
        NumMedia: "1",
      })
    );
    const next = harness.post(
      webhook(messageParams({ From: `whatsapp:${sender}` }))
    );
    while (harness.from.mock.calls.length < 2) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Waits for the next message to reach its chat's queue.
      await new Promise((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(9000);

    expect(harness.source.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await next;

    expect(harness.source.send).toHaveBeenCalledOnce();
  });

  it("goes on in the same chat when there is none yet", async () => {
    const harness = routeHarness();

    await harness.post(webhook(messageParams()));

    expect(harness.resolveSession).toHaveBeenCalledOnce();
    expect(harness.source.end).not.toHaveBeenCalled();
    expect(harness.source.send).toHaveBeenCalledOnce();
  });

  it("caps a number at 30 messages an hour and 200 a day, and says so once an hour", async () => {
    vi.useFakeTimers({
      now: Date.parse("2026-11-25T08:00:00Z"),
      toFake: ["Date"],
    });
    const capped = "+15550000005";
    mocks.config.numbers = `${capped}=member@example.test`;
    const harness = routeHarness();
    const fromCapped = () =>
      harness.post(webhook(messageParams({ From: `whatsapp:${capped}` })));

    for (let sent = 0; sent < 32; sent += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The webhooks arrive one after another.
      await fromCapped();
    }
    expect(harness.source.send).toHaveBeenCalledTimes(30);
    expect(sentBodies().map(({ Body }) => Body)).toEqual([
      "That's the limit for now: 30 messages an hour and 200 a day. Try again later.",
    ]);

    // Each hour reopens 30 more, until the day holds 200.
    for (let hour = 1; hour <= 7; hour += 1) {
      vi.setSystemTime(
        Date.parse("2026-11-25T08:00:00Z") + hour * 60 * 60_000 + 1
      );
      for (let sent = 0; sent < 30; sent += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- The webhooks arrive one after another.
        await fromCapped();
      }
    }
    expect(harness.source.send).toHaveBeenCalledTimes(200);
  });
});

describe("WhatsApp replies", () => {
  const events = mocks.twilioConfig?.events;
  const handleCallSettled = events?.["call.settled"];
  const handleContentCompleted = events?.["content.completed"];
  if (!handleCallSettled || !handleContentCompleted) {
    throw new Error("The WhatsApp channel must configure its reply delivery.");
  }

  function conversation() {
    const request = vi.fn<TwilioHandle["request"]>(async () => ({
      body: { sid: "SM-sent" },
      ok: true,
      status: 201,
    }));
    const twilio = {
      callSid: undefined,
      from: `whatsapp:${memberNumber}`,
      request,
      sendMessage: vi.fn<TwilioHandle["sendMessage"]>(),
      to: companyNumber,
      updateCall: vi.fn<TwilioHandle["updateCall"]>(),
    } satisfies TwilioHandle;
    const context = {
      channel: {
        state: {
          from: `whatsapp:${memberNumber}`,
          lastMessageSid: null,
          to: companyNumber,
        },
        twilio,
      },
      async getSandbox() {
        throw new Error("Sandbox access is outside this focused test.");
      },
      position: { index: 0, line: 2 },
      session: {
        auth: { current: null, initiator: memberPrincipal },
        id: "session-1",
        turn: { id: "turn-1", sequence: 0 },
      },
      view: viewOf([
        [
          {
            data: {
              callId: "call-reply",
              capability: { kind: "tool", name: "send_message" },
              input: {},
              owner: { runId: "run-1" },
            },
            scope: { runId: "run-1", turnId: "turn-1" },
            type: "call.requested",
          },
        ],
      ]),
    } satisfies ChannelEventContext<TwilioEventContext>;
    return { context, request };
  }

  it("splits a long reply into messages of at most 1,600 characters, in order, at paragraph breaks", async () => {
    const { context, request } = conversation();
    const paragraph = "word ".repeat(250).trim();
    const text = [paragraph, paragraph, paragraph, "Last line."].join("\n\n");

    await handleCallSettled(settledReply({ kind: "message", text }), context);

    const bodies = request.mock.calls.map(([, body]) => String(body.Body));
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((body) => body.length <= 1600)).toBe(true);
    expect(bodies.join("\n\n")).toBe(text);
    for (const [path, body] of request.mock.calls) {
      expect(path).toBe(`/2010-04-01/Accounts/${accountSid}/Messages.json`);
      expect(body).toMatchObject({
        From: companyNumber,
        To: `whatsapp:${memberNumber}`,
      });
    }
  });

  it("cuts text without breaks exactly at the limit, never inside a character", async () => {
    const { context, request } = conversation();
    const emoji = String.fromCodePoint(0x1_f6_00);
    const text = `${"x".repeat(1599)}${emoji}${"y".repeat(10)}`;

    await handleCallSettled(settledReply({ kind: "message", text }), context);

    const bodies = request.mock.calls.map(([, body]) => String(body.Body));
    expect(bodies).toEqual(["x".repeat(1599), `${emoji}${"y".repeat(10)}`]);
  });

  it("sends each attachment as a message of its own, after the text", async () => {
    const { context, request } = conversation();

    await handleCallSettled(
      settledReply({
        attachments: [
          { kind: "image", url: "https://files.example/a.png" },
          { kind: "file", url: "https://files.example/b.pdf" },
        ],
        kind: "message",
        text: "Two invoices.",
      }),
      context
    );

    expect(request.mock.calls.map(([, body]) => body)).toEqual([
      expect.objectContaining({ Body: "Two invoices." }),
      expect.objectContaining({ MediaUrl: "https://files.example/a.png" }),
      expect.objectContaining({ MediaUrl: "https://files.example/b.pdf" }),
    ]);
    expect(request.mock.calls.slice(1).map(([, body]) => body.Body)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("fails the delivery when Twilio refuses a message", async () => {
    const { context, request } = conversation();
    request.mockResolvedValue({
      body: { code: 63_016 },
      ok: false,
      status: 400,
    });

    await expect(
      handleCallSettled(settledReply({ kind: "message", text: "Hi" }), context)
    ).rejects.toThrow("Twilio refused a WhatsApp message with HTTP 400.");
  });

  it("sends a chat's reply only while its number is listed for the chat's member", async () => {
    const reply = settledReply({ kind: "message", text: "Your pay list." });
    const listedForAnother = conversation();
    mocks.config.numbers = `${memberNumber}=other@example.test`;

    await handleCallSettled(reply, listedForAnother.context);

    expect(listedForAnother.request).not.toHaveBeenCalled();

    // A chat no WhatsApp member started.
    const notWhatsapp = conversation();
    mocks.config.numbers = `${memberNumber}=member@example.test`;

    await handleCallSettled(reply, {
      ...notWhatsapp.context,
      session: {
        ...notWhatsapp.context.session,
        auth: { current: null, initiator: null },
      },
    });

    expect(notWhatsapp.request).not.toHaveBeenCalled();
  });

  it("posts nothing of the model's own text", async () => {
    const { context, request } = conversation();

    await handleContentCompleted(
      {
        data: {
          kind: "text",
          partId: "part-1",
          phase: "reply",
          runId: "run-1",
          value: "This must not reach WhatsApp.",
        },
        scope: { runId: "run-1", turnId: "turn-1" },
        type: "content.completed",
      },
      context
    );

    expect(request).not.toHaveBeenCalled();
    expect(context.channel.twilio.sendMessage).not.toHaveBeenCalled();
  });
});

function settledReply(output: CallSettled["data"]["output"]): CallSettled {
  return {
    data: { callId: "call-reply", outcome: "completed", output },
    scope: { runId: "run-1", turnId: "turn-1" },
    type: "call.settled",
  };
}
