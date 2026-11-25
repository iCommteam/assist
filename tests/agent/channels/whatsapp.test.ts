import { createHmac } from "node:crypto";
import { inspect } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type {
  ChannelEventContext,
  ChannelEvents,
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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import type { enrolledTeamMemberId } from "@db/services/auth/allowlist";
import {
  admitWhatsappMessage,
  claimWhatsappMessage,
  lockWhatsapp,
  recordWhatsappChat,
  whatsappLockOf,
} from "@db/services/whatsapp";
import { noteWhatsappCancel } from "@agent/lib/whatsapp-access";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { viewOf } from "@tests/helpers/session-view";

// Test fixtures only: a fake account, token and numbers.
const accountSid = `AC${"0".repeat(32)}`;
const authToken = "test-twilio-auth-token-0123456789";
const companyNumber = "whatsapp:+15550000000";
const memberNumber = "+15550000001";
const publicOrigin = "https://assist.example.test";
const loopbackSecret = "test-loopback-secret-0123456789abcdefghij";
// Where Next hands the webhook to eve: not the URL Twilio signed.
const loopbackOrigin = "http://127.0.0.1:4274";
const messagesPath = "/eve/v1/whatsapp/messages";

// What the mocked environment reads; undefined is unset.
interface TestConfig {
  accountSid: string | undefined;
  bigquery: boolean;
  bigqueryEmails: string[];
  authToken: string | undefined;
  from: string | undefined;
  numbers: string;
}

const mocks = vi.hoisted(() => {
  const config: TestConfig = {
    accountSid: undefined,
    bigquery: false,
    bigqueryEmails: [],
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
    get SCHEDULED_RUN_SECRET() {
      return loopbackSecret;
    },
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
  // Only whether BigQuery is configured, and for whom, reaches the channel.
  bigqueryConfig: () => (mocks.config.bigquery ? {} : undefined),
  bigqueryMemberEmails: () => mocks.config.bigqueryEmails,
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

const client = new PGlite();
const database = drizzle(client, { schema });

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
}, 30_000);

afterAll(async () => {
  await client.close();
});

const { default: whatsapp } = await import("@agent/channels/whatsapp");

// The channel's event handlers, as eve receives them: a wider type than
// TwilioChannelEvents, which does not list `committed`.
function channelEvents(): ChannelEvents<TwilioEventContext> {
  const events = mocks.twilioConfig?.events;
  if (!events) throw new Error("The WhatsApp channel must configure events.");
  return events;
}

const twilioCalls: {
  body: URLSearchParams;
  method: string;
  url: string;
}[] = [];
// Twilio's records of incoming messages, by message id: a record, or
// "unreachable" when Twilio's API cannot be reached. A missing one is 404.
const twilioRecords = new Map<string, Record<string, string> | "unreachable">();
// Twilio's media lists of incoming messages, by message id, read the same way.
const twilioMediaLists = new Map<string, unknown>();

beforeEach(async () => {
  vi.clearAllMocks();
  twilioCalls.length = 0;
  twilioRecords.clear();
  twilioMediaLists.clear();
  vi.spyOn(Database, "db", "get").mockReturnValue(
    // SAFETY: PGlite implements the same Drizzle query-builder contract the services use; only the driver changes.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real services with an isolated PostgreSQL-compatible database.
    database as never
  );
  await client.exec(
    "TRUNCATE whatsapp_messages, whatsapp_locks, whatsapp_chats, whatsapp_held_replies, whatsapp_browser_tasks CASCADE"
  );
  Object.assign(mocks.config, {
    accountSid,
    bigquery: false,
    bigqueryEmails: ["member@example.test"],
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
      const method = init?.method ?? "GET";
      twilioCalls.push({
        body:
          init?.body instanceof URLSearchParams
            ? init.body
            : new URLSearchParams(),
        method,
        url,
      });
      if (method === "GET") {
        const listOf = /\/Messages\/([^/]+)\/Media\.json$/u.exec(url)?.[1];
        if (listOf !== undefined) {
          const list = twilioMediaLists.get(decodeURIComponent(listOf));
          if (list === "unreachable") throw new TypeError("fetch failed");
          if (!list) return Response.json({ code: 20_404 }, { status: 404 });
          return Response.json(list);
        }
        const sid = /\/Messages\/([^/]+)\.json$/u.exec(url)?.[1] ?? "";
        const record = twilioRecords.get(decodeURIComponent(sid));
        if (record === "unreachable") throw new TypeError("fetch failed");
        if (!record) return Response.json({ code: 20_404 }, { status: 404 });
        return Response.json(record);
      }
      return Response.json({ sid: "SM-sent" }, { status: 201 });
    })
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let nextMessage = 0;

// A webhook's parameters, and Twilio's matching record of the message.
function messageParams(
  overrides: Partial<Record<"Body" | "From" | "MessageSid" | "To", string>> = {}
) {
  nextMessage += 1;
  const params = {
    AccountSid: accountSid,
    Body: "Which suppliers did we pay twice this month?",
    From: `whatsapp:${memberNumber}`,
    MessageSid: `SM${String(nextMessage).padStart(32, "0")}`,
    NumMedia: "0",
    To: companyNumber,
    ...overrides,
  };
  twilioRecords.set(params.MessageSid, recordOf(params));
  return params;
}

function recordOf(params: Readonly<Record<string, string>>) {
  return {
    account_sid: params.AccountSid ?? "",
    body: params.Body ?? "",
    date_created: new Date().toUTCString(),
    direction: "inbound",
    from: params.From ?? "",
    num_media: params.NumMedia ?? "0",
    sid: params.MessageSid ?? "",
    to: params.To ?? "",
  };
}

const workspaceId = accessScopeForUser("better-auth:user-1").workspaceId;

// The principal a listed member's messages run as: full access, or the
// narrow chat a locked member keeps, exactly as every chat had before.
const memberPrincipal = {
  attributes: {
    conversationChannel: "whatsapp",
    email: "member@example.test",
    whatsappAccess: "full",
    whatsappNumber: memberNumber,
    workspaceId,
  },
  authenticator: "assist-whatsapp",
  principalId: "better-auth:user-1",
  principalType: "user",
};
const narrowPrincipal = {
  attributes: {
    conversationChannel: "whatsapp",
    email: "member@example.test",
    workspaceId,
  },
  authenticator: "assist-whatsapp",
  principalId: "better-auth:user-1",
  principalType: "user",
};

const fullChat = `whatsapp:${memberNumber}:${companyNumber}|better-auth:user-1|full`;
const narrowChat = `whatsapp:${memberNumber}:${companyNumber}|better-auth:user-1`;

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

function fakeDelivery(sessionId = "session-1"): Delivery {
  return {
    deliveryId: "delivery-1",
    result: vi.fn<Delivery["result"]>(),
    sessionId,
    stream: vi.fn<Delivery["stream"]>(),
  };
}

type ChatSession = NonNullable<Awaited<ReturnType<ChannelResolveSession>>>;

// A session whose last recorded line is at `at`.
function sessionLastActiveAt(at: string, id = "session-1"): ChatSession {
  const lastLine: Fact = {
    data: { outcome: "completed", turnId: "turn-1" },
    scope: { turnId: "turn-1" },
    type: "turn.settled",
  };
  return {
    cancel: vi.fn<ChatSession["cancel"]>(),
    clear: vi.fn<ChatSession["clear"]>(),
    compact: vi.fn<ChatSession["compact"]>(),
    end: vi.fn<ChatSession["end"]>(async () => fakeDelivery(id)),
    id,
    prewarm: vi.fn<ChatSession["prewarm"]>(),
    respond: vi.fn<ChatSession["respond"]>(),
    send: vi.fn<ChatSession["send"]>(),
    async *stream() {
      yield { ...lastLine, meta: { at, position: { index: 0, line: 0 } } };
    },
  };
}

// The route's operations, faked: the chat addresses, and the background work
// the route hands off. `session` is the member's open full chat.
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
  const resolveSession = vi.fn<ChannelResolveSession>(async (address) =>
    address.endsWith("|full") ? session : undefined
  );
  const attached: string[] = [];
  const attachSession = vi.fn<
    RouteHandlerArgs<TwilioChannelState>["attachSession"]
  >((sessionId) => {
    const attachedSession = sessionLastActiveAt(
      new Date().toISOString(),
      sessionId
    );
    attachedSession.end = vi.fn<ChatSession["end"]>(async () => {
      attached.push(sessionId);
      return fakeDelivery(sessionId);
    });
    return attachedSession;
  });
  const args = {
    attachSession,
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
    attached,
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
  return twilioCalls
    .filter(({ method }) => method === "POST")
    .map(({ body }) => ({
      Body: body.get("Body"),
      From: body.get("From"),
      MediaUrl: body.get("MediaUrl"),
      To: body.get("To"),
    }));
}

function sentTexts() {
  return sentBodies().map(({ Body }) => Body);
}

function recordReads() {
  return twilioCalls.filter(({ method }) => method === "GET");
}

// What a failed query throws: like drizzle's, its message names the query's
// values, here the member's number, email and a reply's text.
class FailedQuery extends Error {
  override name = "DrizzleQueryError";
}

const failedValues = [memberNumber, "member@example.test", "1 Main St"];

function failDatabase() {
  vi.spyOn(Database, "db", "get").mockImplementation(() => {
    throw new FailedQuery(
      `Failed query: insert into "whatsapp_held_replies" params: Your saved address is 1 Main St,full,${memberNumber},member@example.test,better-auth:user-1`
    );
  });
}

// The failed query's values found in anything logged, inspected as eve's
// logger inspects an error: none, every time.
function loggedValues() {
  const logged = [console.warn, console.error, console.info]
    .map((log) =>
      vi.isMockFunction(log) ? inspect(log.mock.calls, { depth: 10 }) : ""
    )
    .join("\n");
  return failedValues.filter((value) => logged.includes(value));
}

const announcement =
  "Full access is on in this chat: the browser, vault links, Personal Info and saved notes. Reply /lock to turn it off.";

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
      expect(twilioCalls).toEqual([]);
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

  it("admits a listed member with full access, checks Twilio's record, and opens the chat with its fixed line once", async () => {
    const harness = routeHarness();
    const params = messageParams();

    const response = await harness.post(webhook(params));
    await harness.post(webhook(messageParams({ Body: "And last month?" })));

    expect(response.status).toBe(200);
    expect(mocks.enrolledTeamMemberId).toHaveBeenCalledWith(
      "member@example.test"
    );
    expect(harness.operations).toEqual([
      { address: fullChat, operation: "send" },
      { address: fullChat, operation: "send" },
    ]);
    expect(harness.source.send).toHaveBeenNthCalledWith(
      1,
      "Which suppliers did we pay twice this month?",
      expect.objectContaining({ auth: memberPrincipal })
    );
    expect(recordReads().map(({ url }) => url)[0]).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${params.MessageSid}.json`
    );
    expect(sentTexts()).toEqual([announcement]);
  });

  it("names the company's BigQuery in the fixed line for a member on ASSIST_BIGQUERY_EMAILS while it is configured", async () => {
    mocks.config.bigquery = true;
    const harness = routeHarness();

    await harness.post(webhook(messageParams()));

    expect(sentTexts()).toEqual([
      "Full access is on in this chat: the browser, vault links, Personal Info, saved notes and the company's BigQuery data, read only. Reply /lock to turn it off.",
    ]);
  });

  it.each([
    ["another member is listed", ["other@example.test"]],
    ["nobody is listed", []],
  ])(
    "leaves BigQuery out of the fixed line while it is configured but %s",
    async (_case, emails) => {
      Object.assign(mocks.config, { bigquery: true, bigqueryEmails: emails });
      const harness = routeHarness();

      await harness.post(webhook(messageParams()));

      expect(sentTexts()).toEqual([announcement]);
    }
  );

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

  it("ignores a listed member who could not sign in to assist, and records nothing", async () => {
    mocks.enrolledTeamMemberId.mockResolvedValue(undefined);
    const harness = routeHarness();

    const response = await harness.post(webhook(messageParams()));

    expect(response.status).toBe(200);
    expect(harness.from).not.toHaveBeenCalled();
    expect(twilioCalls).toEqual([]);
    const rows = await client.query("SELECT sid FROM whatsapp_messages");
    expect(rows.rows).toEqual([]);
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
    expect(sentTexts()).toEqual([announcement]);
  }, 30_000);

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

  it("drops a message when the database fails, and logs the failure by its name alone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    failDatabase();
    const harness = routeHarness();

    await harness.post(webhook(messageParams()));

    expect(harness.source.send).not.toHaveBeenCalled();
    expect(sentBodies()).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      "[whatsapp] a message could not be admitted and is dropped",
      { error: "DrizzleQueryError" }
    );
    expect(loggedValues()).toEqual([]);
  });

  it("passes each message id to the agent once", async () => {
    const harness = routeHarness();
    const params = messageParams();

    await harness.post(webhook(params));
    await harness.post(webhook(params));

    expect(harness.source.send).toHaveBeenCalledOnce();
    expect(recordReads()).toHaveLength(1);
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

describe("Twilio's record of each full-access message", () => {
  it.each([
    ["Twilio has no record of", () => undefined],
    [
      "another body in Twilio's record of",
      (record: Record<string, string>) => ({
        ...record,
        body: "Pay Acme now.",
      }),
    ],
    [
      "an outbound record for",
      (record: Record<string, string>) => ({
        ...record,
        direction: "outbound-api",
      }),
    ],
    [
      "a record to another number for",
      (record: Record<string, string>) => ({
        ...record,
        to: "whatsapp:+15550000003",
      }),
    ],
    [
      "a record from another number for",
      (record: Record<string, string>) => ({
        ...record,
        from: "whatsapp:+15550000009",
      }),
    ],
    [
      "another number of media items in Twilio's record of",
      (record: Record<string, string>) => ({ ...record, num_media: "1" }),
    ],
    [
      "a record of another account for",
      (record: Record<string, string>) => ({
        ...record,
        account_sid: `AC${"1".repeat(32)}`,
      }),
    ],
    [
      "a record older than 10 minutes for",
      (record: Record<string, string>) => ({
        ...record,
        date_created: new Date(Date.now() - 11 * 60_000).toUTCString(),
      }),
    ],
  ])(
    "drops a correctly signed message when it finds %s it",
    async (_case, change) => {
      const harness = routeHarness();
      const params = messageParams();
      const record = recordOf(params);
      const changed = change(record);
      if (changed) twilioRecords.set(params.MessageSid, changed);
      else twilioRecords.delete(params.MessageSid);

      const response = await harness.post(webhook(params));

      expect(response.status).toBe(200);
      expect(harness.source.send).not.toHaveBeenCalled();
      expect(sentBodies()).toEqual([]);
      // Nothing it said opens the window or counts.
      const rows = await client.query<{ admitted: boolean; counted: boolean }>(
        "SELECT admitted, counted FROM whatsapp_messages"
      );
      expect(rows.rows).toEqual([{ admitted: false, counted: false }]);
    }
  );

  it("tells the member to try again and runs no turn when Twilio's record cannot be read", async () => {
    const harness = routeHarness();
    const params = messageParams();
    twilioRecords.set(params.MessageSid, "unreachable");

    await harness.post(webhook(params));

    expect(harness.source.send).not.toHaveBeenCalled();
    expect(sentTexts()).toEqual([
      "Twilio cannot be reached right now, so that message was not read. Try again in a minute.",
    ]);
  });

  it("gives a locked member today's narrow chat, at today's address, without reading the record", async () => {
    await lockWhatsapp("user-1", "web");
    const harness = routeHarness();
    const params = messageParams();
    twilioRecords.delete(params.MessageSid);

    await harness.post(webhook(params));

    expect(recordReads()).toEqual([]);
    expect(harness.operations).toEqual([
      { address: narrowChat, operation: "send" },
    ]);
    expect(harness.source.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ auth: narrowPrincipal })
    );
    expect(sentTexts()).toEqual([]);
  });

  it("gives everyone the narrow chat while an administrator locked everyone", async () => {
    await lockWhatsapp("*", "admin");
    const harness = routeHarness();

    await harness.post(webhook(messageParams()));

    expect(harness.operations).toEqual([
      { address: narrowChat, operation: "send" },
    ]);
  });
});

// The address Twilio's webhook gives a media item, and Twilio's list of a
// message's media.
function mediaUrl(messageSid: string, mediaSid: string, account = accountSid) {
  return `https://api.twilio.com/2010-04-01/Accounts/${account}/Messages/${messageSid}/Media/${mediaSid}`;
}

function mediaListOf(messageSid: string, sids: readonly string[]) {
  return {
    media_list: sids.map((sid) => ({
      account_sid: accountSid,
      content_type: "image/jpeg",
      parent_sid: messageSid,
      sid,
      uri: `/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}/Media/${sid}.json`,
    })),
    next_page_uri: null,
  };
}

describe("Twilio's record of each media item", () => {
  const imageSid = `ME${"a".repeat(32)}`;
  const otherSid = `ME${"b".repeat(32)}`;

  // A signed photo message, with Twilio's record of it and its media list.
  function photoMessage() {
    const base = messageParams({ Body: "Is this the right invoice?" });
    const params = {
      ...base,
      MediaContentType0: "image/jpeg",
      MediaUrl0: mediaUrl(base.MessageSid, imageSid),
      NumMedia: "1",
    };
    twilioRecords.set(base.MessageSid, recordOf(params));
    twilioMediaLists.set(
      base.MessageSid,
      mediaListOf(base.MessageSid, [imageSid])
    );
    return { params, sid: base.MessageSid };
  }

  it("admits a photo whose item is on Twilio's own list of that message, with its content type", async () => {
    const harness = routeHarness();
    const { params, sid } = photoMessage();

    await harness.post(webhook(params));

    expect(harness.source.send).toHaveBeenCalledExactlyOnceWith(
      [
        { text: "Is this the right invoice?", type: "text" },
        {
          data: new URL(mediaUrl(sid, imageSid)),
          mediaType: "image/jpeg",
          type: "file",
        },
      ],
      expect.objectContaining({ auth: memberPrincipal })
    );
    expect(recordReads().map(({ url }) => url)).toEqual([
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`,
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${sid}/Media.json`,
    ]);
  });

  it("reads no media list for a message without media", async () => {
    const harness = routeHarness();

    await harness.post(webhook(messageParams()));

    expect(harness.source.send).toHaveBeenCalledOnce();
    expect(recordReads()).toHaveLength(1);
  });

  it.each([
    [
      "an item on another host",
      (sid: string) => ({
        MediaUrl0: mediaUrl(sid, imageSid).replace(
          "https://api.twilio.com",
          "https://media.example.test"
        ),
      }),
    ],
    [
      "an item of another message",
      () => ({ MediaUrl0: mediaUrl(`MM${"c".repeat(32)}`, imageSid) }),
    ],
    [
      "an item of another account",
      (sid: string) => ({
        MediaUrl0: mediaUrl(sid, imageSid, `AC${"1".repeat(32)}`),
      }),
    ],
    [
      "an item missing from Twilio's list",
      (sid: string) => ({ MediaUrl0: mediaUrl(sid, otherSid) }),
    ],
    [
      "an item with another content type",
      () => ({ MediaContentType0: "application/pdf" }),
    ],
    [
      "an item's address with a query",
      (sid: string) => ({
        MediaUrl0: `${mediaUrl(sid, imageSid)}?Download=true`,
      }),
    ],
    [
      "an item's address with another port",
      (sid: string) => ({
        MediaUrl0: mediaUrl(sid, imageSid).replace(
          "api.twilio.com",
          "api.twilio.com:443"
        ),
      }),
    ],
  ])(
    "drops a correctly signed photo message with %s",
    async (_case, change) => {
      const harness = routeHarness();
      const { params, sid } = photoMessage();

      await harness.post(webhook({ ...params, ...change(sid) }));

      expect(harness.source.send).not.toHaveBeenCalled();
      expect(sentBodies()).toEqual([]);
      const rows = await client.query<{ admitted: boolean }>(
        "SELECT admitted FROM whatsapp_messages"
      );
      expect(rows.rows).toEqual([{ admitted: false }]);
    }
  );

  it("drops a message that names one item twice, or whose list holds another item, another message's item or a second page", async () => {
    const harness = routeHarness();
    const twice = photoMessage();
    const twiceParams = {
      ...twice.params,
      MediaContentType1: "image/jpeg",
      MediaUrl1: mediaUrl(twice.sid, imageSid),
      NumMedia: "2",
    };
    twilioRecords.set(twice.sid, recordOf(twiceParams));
    twilioMediaLists.set(
      twice.sid,
      mediaListOf(twice.sid, [imageSid, otherSid])
    );
    await harness.post(webhook(twiceParams));

    const extra = photoMessage();
    twilioMediaLists.set(
      extra.sid,
      mediaListOf(extra.sid, [imageSid, otherSid])
    );
    await harness.post(webhook(extra.params));

    const foreign = photoMessage();
    twilioMediaLists.set(foreign.sid, {
      media_list: [
        {
          account_sid: accountSid,
          content_type: "image/jpeg",
          parent_sid: `MM${"d".repeat(32)}`,
          sid: imageSid,
        },
      ],
      next_page_uri: null,
    });
    await harness.post(webhook(foreign.params));

    const paged = photoMessage();
    twilioMediaLists.set(paged.sid, {
      ...mediaListOf(paged.sid, [imageSid]),
      next_page_uri: "/next",
    });
    await harness.post(webhook(paged.params));

    expect(harness.source.send).not.toHaveBeenCalled();
    expect(sentBodies()).toEqual([]);
  });

  it("drops a photo message Twilio lists no media for, and asks the member to try again when the list cannot be read", async () => {
    const harness = routeHarness();
    const missing = photoMessage();
    twilioMediaLists.delete(missing.sid);
    await harness.post(webhook(missing.params));
    expect(sentBodies()).toEqual([]);

    const unreadable = photoMessage();
    twilioMediaLists.set(unreadable.sid, "unreachable");
    await harness.post(webhook(unreadable.params));

    expect(harness.source.send).not.toHaveBeenCalled();
    expect(sentTexts()).toEqual([
      "Twilio cannot be reached right now, so that message was not read. Try again in a minute.",
    ]);
  });
});

describe("WhatsApp chats", () => {
  it("ends the chat on /new, confirms it, and passes nothing to the agent", async () => {
    const harness = routeHarness(sessionLastActiveAt(new Date().toISOString()));

    await harness.post(webhook(messageParams({ Body: " /New " })));

    expect(harness.operations).toEqual([
      { address: fullChat, operation: "end" },
    ]);
    expect(harness.source.send).not.toHaveBeenCalled();
    expect(sentBodies()).toEqual([
      {
        Body: "Started a new chat. What can I help with?",
        From: companyNumber,
        MediaUrl: null,
        To: `whatsapp:${memberNumber}`,
      },
    ]);

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
    expect(sentTexts()).toEqual([
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
    expect(sentBodies()).toEqual([]);
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
      `whatsapp:${number}:${companyNumber}|better-auth:${userId}|full`;
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

  it("ends the chat at the other level when the member's access changes", async () => {
    const harness = routeHarness();
    harness.resolveSession.mockImplementation(async (address) =>
      address === narrowChat
        ? sessionLastActiveAt(new Date().toISOString(), "session-narrow")
        : undefined
    );

    await harness.post(webhook(messageParams()));

    expect(harness.operations).toEqual([
      { address: narrowChat, operation: "end" },
      { address: fullChat, operation: "send" },
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
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.operations).toEqual([]);

    lookups[0]?.("user-1");
    mocks.enrolledTeamMemberId.mockResolvedValue("user-1");
    await Promise.all([newChat, payList]);

    expect(harness.operations.map(({ operation }) => operation)).toEqual([
      "end",
      "send",
    ]);
    expect(harness.source.send).toHaveBeenCalledExactlyOnceWith(
      "Pay list for March",
      expect.anything()
    );
    expect(sentTexts()[0]).toBe("Started a new chat. What can I help with?");
  });

  it("holds a sender's next message for 10 seconds at most behind one that never reached its chat", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sender = "+15550000007";
    mocks.config.numbers = `${sender}=member@example.test`;
    const harness = routeHarness();

    // A media address eve cannot read: a locked member's narrow chat takes
    // the message as it came, with no record to bind its media to, and it
    // never reaches its chat. A full chat would drop it at Twilio's record.
    await lockWhatsapp("user-1", "web");
    const broken = {
      ...messageParams({ From: `whatsapp:${sender}` }),
      MediaUrl0: "not a URL",
      NumMedia: "1",
    };
    twilioRecords.set(broken.MessageSid, recordOf(broken));
    await harness.post(webhook(broken));
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

    expect(harness.resolveSession).toHaveBeenCalledWith(fullChat);
    expect(harness.source.end).not.toHaveBeenCalled();
    expect(harness.source.send).toHaveBeenCalledOnce();
  });

  it("caps a number at 30 messages an hour and 200 a day, and says so once an hour", async () => {
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
    expect(sentTexts()).toEqual([
      announcement,
      "That's the limit for now: 30 messages an hour and 200 a day. Try again later.",
    ]);

    // Each hour reopens 30 more, until the day holds 200.
    for (let hour = 1; hour <= 7; hour += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- An hour passes for every counted message.
      await client.exec(
        "UPDATE whatsapp_messages SET received_at = received_at - interval '61 minutes'"
      );
      for (let sent = 0; sent < 30; sent += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- The webhooks arrive one after another.
        await fromCapped();
      }
    }
    expect(harness.source.send).toHaveBeenCalledTimes(200);
  }, 120_000);

  it("keeps the dedupe and the caps across a restart", async () => {
    const harness = routeHarness();
    const params = messageParams();
    await harness.post(webhook(params));

    const beforeRestart = mocks.twilioConfig;
    onTestFinished(() => {
      mocks.twilioConfig = beforeRestart;
    });
    vi.resetModules();
    const Restarted = await import("@db");
    vi.spyOn(Restarted, "db", "get").mockReturnValue(
      // SAFETY: as above, the restarted modules use the same test database.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real services with an isolated PostgreSQL-compatible database.
      database as never
    );
    const { default: restarted } = await import("@agent/channels/whatsapp");
    const route = restarted.routes.find(
      (definition) =>
        definition.path === messagesPath && definition.method === "POST"
    );
    if (!route || route.transport === "websocket") throw new Error("route");
    const after = routeHarness();
    const tasks: Promise<unknown>[] = [];
    const post = async (request: Request) => {
      await route.handler(request, {
        attachSession:
          vi.fn<RouteHandlerArgs<TwilioChannelState>["attachSession"]>(),
        describe: vi.fn<RouteHandlerArgs<TwilioChannelState>["describe"]>(),
        from: after.from,
        invokeTool: vi.fn<RouteHandlerArgs<TwilioChannelState>["invokeTool"]>(),
        listSkillFiles:
          vi.fn<RouteHandlerArgs<TwilioChannelState>["listSkillFiles"]>(),
        params: {},
        readSkill: vi.fn<RouteHandlerArgs<TwilioChannelState>["readSkill"]>(),
        requestIp: null,
        resolveSession: after.resolveSession,
        to: vi.fn<RouteHandlerArgs<TwilioChannelState>["to"]>(),
        waitUntil(task: Promise<unknown>) {
          tasks.push(task);
        },
      });
      await Promise.all(tasks);
    };

    await post(webhook(params));
    expect(after.source.send).not.toHaveBeenCalled();

    await client.exec(
      "UPDATE whatsapp_messages SET counted = true; INSERT INTO whatsapp_messages (sid, phone, admitted, counted) SELECT 'SM' || lpad(n::text, 32, 'f'), '+15550000001', true, true FROM generate_series(1, 29) AS n"
    );
    await post(webhook(messageParams()));
    expect(after.source.send).not.toHaveBeenCalled();
  });
});

describe("/lock", () => {
  it("locks WhatsApp, ends the member's full chats, says so, and never reaches the agent", async () => {
    await client.exec(
      `INSERT INTO workspaces (id) VALUES ('${workspaceId}') ON CONFLICT DO NOTHING`
    );
    await recordWhatsappChat({
      email: "member@example.test",
      messageAt: new Date(),
      messageSid: `SM${"a".repeat(32)}`,
      phone: memberNumber,
      sessionId: "session-full",
      userId: "better-auth:user-1",
      workspaceId,
    });
    const harness = routeHarness(sessionLastActiveAt(new Date().toISOString()));
    const params = messageParams({ Body: "/LOCK" });
    twilioRecords.delete(params.MessageSid);

    await harness.post(webhook(params));

    await expect(whatsappLockOf("user-1")).resolves.toEqual({
      everyone: false,
      self: true,
    });
    expect(harness.attached).toEqual(["session-full"]);
    expect(harness.operations).toEqual([
      { address: fullChat, operation: "end" },
    ]);
    expect(harness.source.send).not.toHaveBeenCalled();
    expect(sentTexts()).toEqual([
      `Full access is off on WhatsApp. Turn it back on in assist: ${publicOrigin}/`,
    ]);
    const chats = await client.query<{ ended: boolean }>(
      "SELECT ended_at IS NOT NULL AS ended FROM whatsapp_chats"
    );
    expect(chats.rows).toEqual([{ ended: true }]);

    // The member's next message reaches the narrow chat.
    await harness.post(webhook(messageParams({ Body: "Hello" })));
    expect(harness.operations.at(-1)).toEqual({
      address: narrowChat,
      operation: "send",
    });
  });

  it("sends no fixed line for a full chat that a lock overtook as it opened", async () => {
    const harness = routeHarness();
    harness.source.send.mockImplementation(async () => {
      await lockWhatsapp("user-1", "web");
      return fakeDelivery();
    });

    await harness.post(webhook(messageParams()));

    expect(harness.operations).toEqual([
      { address: fullChat, operation: "send" },
    ]);
    expect(sentTexts()).toEqual([]);
    const chats = await client.query<{ announced: boolean }>(
      "SELECT announced_at IS NOT NULL AS announced FROM whatsapp_chats"
    );
    expect(chats.rows).toEqual([{ announced: false }]);
  });

  it("locks over the limit too, without a reply", async () => {
    const harness = routeHarness();
    await client.exec(
      "INSERT INTO whatsapp_messages (sid, phone, admitted, counted) SELECT 'SM' || lpad(n::text, 32, 'e'), '+15550000001', true, true FROM generate_series(1, 30) AS n"
    );

    await harness.post(webhook(messageParams({ Body: "/lock" })));

    await expect(whatsappLockOf("user-1")).resolves.toMatchObject({
      self: true,
    });
    expect(sentBodies()).toEqual([]);
  });

  it("ends the chats a lock on the Workspace page covers, on loopback only", async () => {
    await client.exec(
      `INSERT INTO workspaces (id) VALUES ('${workspaceId}') ON CONFLICT DO NOTHING`
    );
    await recordWhatsappChat({
      email: "member@example.test",
      messageAt: new Date(),
      messageSid: `SM${"b".repeat(32)}`,
      phone: memberNumber,
      sessionId: "session-web-lock",
      userId: "better-auth:user-1",
      workspaceId,
    });
    const harness = routeHarness();
    const end = (authorization?: string) => {
      const headers = new Headers({ "content-type": "application/json" });
      if (authorization !== undefined) {
        headers.set("authorization", authorization);
      }
      return new Request(`${loopbackOrigin}/internal/whatsapp/end`, {
        body: JSON.stringify({ member: "better-auth:user-1" }),
        headers,
        method: "POST",
      });
    };

    const refused = await harness.post(end(), "/internal/whatsapp/end");
    const wrong = await harness.post(
      end("Bearer not-the-secret-0123456789abcdef"),
      "/internal/whatsapp/end"
    );
    expect(refused.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(harness.attached).toEqual([]);

    const ended = await harness.post(
      end(`Bearer ${loopbackSecret}`),
      "/internal/whatsapp/end"
    );
    expect(ended.status).toBe(204);
    expect(harness.attached).toEqual(["session-web-lock"]);
  });
});

describe("WhatsApp replies", () => {
  function conversation(
    initiator: typeof memberPrincipal | typeof narrowPrincipal = memberPrincipal
  ) {
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
        auth: { current: null, initiator },
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

  // The member wrote from their number `minutesAgo` minutes ago.
  async function memberWrote(minutesAgo = 1) {
    const sid = `SM${String((nextMessage += 1)).padStart(32, "c")}`;
    await claimWhatsappMessage(sid, memberNumber);
    await admitWhatsappMessage(sid);
    await client.query(
      `UPDATE whatsapp_messages SET received_at = now() - make_interval(mins => $1) WHERE sid = $2`,
      [minutesAgo, sid]
    );
  }

  function handlers() {
    const {
      "call.settled": callSettled,
      "content.completed": contentCompleted,
    } = channelEvents();
    if (!callSettled || !contentCompleted) {
      throw new Error(
        "The WhatsApp channel must configure its reply delivery."
      );
    }
    return { callSettled, contentCompleted };
  }

  beforeEach(async () => {
    await memberWrote();
  });

  it("splits a long reply into messages of at most 1,600 characters, in order, at paragraph breaks", async () => {
    const { context, request } = conversation();
    const paragraph = "word ".repeat(250).trim();
    const text = [paragraph, paragraph, paragraph, "Last line."].join("\n\n");

    await handlers().callSettled(
      settledReply({ kind: "message", text }),
      context
    );

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

    await handlers().callSettled(
      settledReply({ kind: "message", text }),
      context
    );

    const bodies = request.mock.calls.map(([, body]) => String(body.Body));
    expect(bodies).toEqual(["x".repeat(1599), `${emoji}${"y".repeat(10)}`]);
  });

  it("sends each attachment as a message of its own, after the text", async () => {
    const { context, request } = conversation();

    await handlers().callSettled(
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

  it("logs a reply Twilio refuses by the error's name alone", async () => {
    const { context, request } = conversation();
    request.mockResolvedValue({
      body: { code: 63_016 },
      ok: false,
      status: 400,
    });

    await handlers().callSettled(
      settledReply({ kind: "message", text: "Hi" }),
      context
    );

    expect(request).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      "[whatsapp] a reply could not be sent",
      { error: "Error" }
    );
  });

  it("logs a database failure while sending or holding a reply by its name alone", async () => {
    const { context, request } = conversation();
    failDatabase();

    await handlers().callSettled(
      settledReply({
        kind: "message",
        text: "Your saved address is 1 Main St",
      }),
      context
    );

    expect(request).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "[whatsapp] a reply could not be sent",
      { error: "DrizzleQueryError" }
    );
    expect(loggedValues()).toEqual([]);
  });

  it("sends a chat's reply only while its number is listed for the chat's member", async () => {
    const reply = settledReply({ kind: "message", text: "Your pay list." });
    const listedForAnother = conversation();
    mocks.config.numbers = `${memberNumber}=other@example.test`;

    await handlers().callSettled(reply, listedForAnother.context);

    expect(listedForAnother.request).not.toHaveBeenCalled();

    // A chat no WhatsApp member started.
    const notWhatsapp = conversation();
    mocks.config.numbers = `${memberNumber}=member@example.test`;

    await handlers().callSettled(reply, {
      ...notWhatsapp.context,
      session: {
        ...notWhatsapp.context.session,
        auth: { current: null, initiator: null },
      },
    });

    expect(notWhatsapp.request).not.toHaveBeenCalled();
  });

  it("sends a full chat's reply only while full access is on, and a narrow chat's either way", async () => {
    const reply = settledReply({ kind: "message", text: "Your pay list." });
    await lockWhatsapp("user-1", "whatsapp");

    const full = conversation();
    await handlers().callSettled(reply, full.context);
    expect(full.request).not.toHaveBeenCalled();

    const narrow = conversation(narrowPrincipal);
    await handlers().callSettled(reply, narrow.context);
    expect(narrow.request).toHaveBeenCalledOnce();
  });

  it("posts nothing of the model's own text", async () => {
    const { context, request } = conversation();

    await handlers().contentCompleted(
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

  it("holds a reply past the member's 24-hour window and sends it first when they next write", async () => {
    await client.exec("TRUNCATE whatsapp_messages");
    await memberWrote(24 * 60 - 5);
    const { context, request } = conversation();

    await handlers().callSettled(
      settledReply({ kind: "message", text: "Your pay list is ready." }),
      context
    );
    expect(request).not.toHaveBeenCalled();

    const harness = routeHarness();
    await harness.post(webhook(messageParams({ Body: "Thanks" })));

    expect(sentTexts()).toEqual(["Your pay list is ready.", announcement]);
    expect(harness.source.send).toHaveBeenCalledOnce();
    const held = await client.query("SELECT id FROM whatsapp_held_replies");
    expect(held.rows).toEqual([]);
  });

  it("drops a held full-access reply when the member locked WhatsApp meanwhile", async () => {
    await client.exec("TRUNCATE whatsapp_messages");
    await memberWrote(25 * 60);
    const { context } = conversation();
    await handlers().callSettled(
      settledReply({ kind: "message", text: "Your saved address is…" }),
      context
    );
    await lockWhatsapp("user-1", "whatsapp");

    await routeHarness().post(webhook(messageParams({ Body: "Hi" })));

    expect(sentTexts()).toEqual([]);
  });

  it("sends no full chat's held reply, and opens no full chat, for a message a lock overtook during Twilio's record check", async () => {
    await client.exec("TRUNCATE whatsapp_messages");
    await memberWrote(25 * 60);
    const { context } = conversation();
    await handlers().callSettled(
      settledReply({ kind: "message", text: "Your saved address is…" }),
      context
    );
    // The lock lands while Twilio's record of the message is read.
    const readTwilio = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        await lockWhatsapp("user-1", "web");
      }
      if (!readTwilio) throw new Error("Twilio's API must be faked.");
      return readTwilio(input, init);
    });
    const harness = routeHarness();

    await harness.post(webhook(messageParams({ Body: "ok" })));

    expect(recordReads()).toHaveLength(1);
    expect(sentTexts()).toEqual([]);
    expect(harness.operations).toEqual([
      { address: narrowChat, operation: "send" },
    ]);
    expect(harness.source.send).toHaveBeenCalledExactlyOnceWith(
      "ok",
      expect.objectContaining({ auth: narrowPrincipal })
    );
    const held = await client.query("SELECT id FROM whatsapp_held_replies");
    expect(held.rows).toEqual([]);
    const chats = await client.query("SELECT id FROM whatsapp_chats");
    expect(chats.rows).toEqual([]);
  });

  it("sends the held replies before /new ends the chat, and none reaches the new one", async () => {
    await client.exec("TRUNCATE whatsapp_messages");
    await memberWrote(24 * 60 - 5);
    const { context } = conversation();
    await handlers().callSettled(
      settledReply({ kind: "message", text: "Your pay list is ready." }),
      context
    );
    const harness = routeHarness(sessionLastActiveAt(new Date().toISOString()));

    await harness.post(webhook(messageParams({ Body: "/new" })));

    expect(sentTexts()).toEqual([
      "Your pay list is ready.",
      "Started a new chat. What can I help with?",
    ]);
    expect(harness.operations).toEqual([
      { address: fullChat, operation: "end" },
    ]);
    const held = await client.query("SELECT id FROM whatsapp_held_replies");
    expect(held.rows).toEqual([]);

    await harness.post(webhook(messageParams({ Body: "Hi" })));

    expect(sentTexts()).toEqual([
      "Your pay list is ready.",
      "Started a new chat. What can I help with?",
      announcement,
    ]);
  });
});

describe("WhatsApp prompts and notices", () => {
  function promptContext(
    facts: readonly Fact[],
    initiator: typeof memberPrincipal | null = memberPrincipal
  ) {
    const request = vi.fn<TwilioHandle["request"]>(async () => ({
      body: { sid: "SM-sent" },
      ok: true,
      status: 201,
    }));
    const state: TwilioChannelState = {
      from: `whatsapp:${memberNumber}`,
      lastMessageSid: null,
      to: companyNumber,
    };
    const context = {
      channel: {
        state,
        twilio: {
          callSid: undefined,
          from: `whatsapp:${memberNumber}`,
          request,
          sendMessage: vi.fn<TwilioHandle["sendMessage"]>(),
          to: companyNumber,
          updateCall: vi.fn<TwilioHandle["updateCall"]>(),
        },
      },
      async getSandbox() {
        throw new Error("Sandbox access is outside this focused test.");
      },
      position: { index: 0, line: 3 },
      session: {
        auth: { current: null, initiator },
        id: "session-1",
        turn: { id: "turn-1", sequence: 0 },
      },
      view: viewOf([facts]),
    } satisfies ChannelEventContext<TwilioEventContext>;
    return { context, request };
  }

  const question = opened("question-1", {
    kind: "question",
    options: [
      { id: "march", label: "March" },
      { description: "the quarter", id: "q1", label: "Q1" },
    ],
    prompt: "Which period?",
  });
  const signIn = opened("sign-in-1", {
    kind: "sign-in",
    prompt: "Connect your account.",
  });
  const budget = opened("budget-1", {
    kind: "budget",
    options: [
      { id: "continue", label: "Continue" },
      { id: "stop", label: "Stop" },
    ],
    prompt: "This chat reached its usage limit. Continue?",
  });

  async function wroteRecently() {
    const sid = `SM${String((nextMessage += 1)).padStart(32, "d")}`;
    await claimWhatsappMessage(sid, memberNumber);
    await admitWhatsappMessage(sid);
  }

  function committed() {
    const handler = channelEvents().committed;
    if (!handler) throw new Error("The channel must draw its own prompts.");
    return handler;
  }

  it("draws the question a typed number answers, once, through the reply gate", async () => {
    await wroteRecently();
    const { context, request } = promptContext([signIn, question]);
    const line = { facts: [], position: 3 };

    await committed()(line, context);
    await committed()(line, context);

    expect(request.mock.calls.map(([, body]) => body.Body)).toEqual([
      "Which period?\n\n1. March\n2. Q1 - the quarter\n\nReply with a number to choose.",
    ]);
  });

  it("draws the usage limit's prompt before an older question, as eve answers it first", async () => {
    await wroteRecently();
    const { context, request } = promptContext([question, budget]);

    await committed()({ facts: [], position: 3 }, context);

    expect(String(request.mock.calls[0]?.[1].Body)).toMatch(
      /^This chat reached its usage limit\. Continue\?/u
    );
  });

  it("draws no prompt for a number no longer listed, a locked full chat, or outside the window", async () => {
    const line = { facts: [], position: 3 };
    const outside = promptContext([question]);
    await committed()(line, outside.context);
    expect(outside.request).not.toHaveBeenCalled();

    await wroteRecently();
    mocks.config.numbers = `${memberNumber}=other@example.test`;
    const unlisted = promptContext([question]);
    await committed()(line, unlisted.context);
    expect(unlisted.request).not.toHaveBeenCalled();

    mocks.config.numbers = `${memberNumber}=member@example.test`;
    await lockWhatsapp("user-1", "web");
    const locked = promptContext([question]);
    await committed()(line, locked.context);
    expect(locked.request).not.toHaveBeenCalled();
  });

  it("logs a database failure while drawing a question by its name alone", async () => {
    const { context, request } = promptContext([question]);
    failDatabase();

    await committed()({ facts: [], position: 3 }, context);

    expect(request).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "[whatsapp] a question could not be sent",
      { error: "DrizzleQueryError" }
    );
    expect(loggedValues()).toEqual([]);
  });

  it("posts no sign-in challenge", async () => {
    await wroteRecently();
    const opener = channelEvents()["interaction.opened"];
    const { context, request } = promptContext([signIn]);

    await opener?.(
      {
        data: {
          interactionId: "sign-in-1",
          request: { kind: "sign-in", prompt: "Connect your account." },
          subject: { turnId: "turn-1" },
        },
        scope: { turnId: "turn-1" },
        type: "interaction.opened",
      },
      context
    );
    await committed()({ facts: [], position: 3 }, context);

    expect(request).not.toHaveBeenCalled();
    expect(context.channel.twilio.sendMessage).not.toHaveBeenCalled();
  });

  it("tells the member a turn failed, or why the access hook stopped it, through the gate", async () => {
    await wroteRecently();
    const settled = channelEvents()["turn.settled"];
    const failed = promptContext([]);
    await settled?.(
      {
        data: { outcome: "failed", turnId: "turn-1" },
        scope: { turnId: "turn-1" },
        type: "turn.settled",
      },
      failed.context
    );
    expect(failed.request.mock.calls.map(([, body]) => body.Body)).toEqual([
      "Something went wrong with that message. Try again, or reply /new to start over.",
    ]);

    const cancelled = promptContext([]);
    noteWhatsappCancel("session-1", "turn-2", "A fixed notice.");
    await settled?.(
      {
        data: {
          cause: { hook: "whatsapp-access" },
          outcome: "cancelled",
          turnId: "turn-2",
        },
        scope: { turnId: "turn-2" },
        type: "turn.settled",
      },
      cancelled.context
    );
    expect(cancelled.request.mock.calls.map(([, body]) => body.Body)).toEqual([
      "A fixed notice.",
    ]);

    mocks.config.numbers = "";
    const unlisted = promptContext([]);
    await settled?.(
      {
        data: { outcome: "failed", turnId: "turn-3" },
        scope: { turnId: "turn-3" },
        type: "turn.settled",
      },
      unlisted.context
    );
    expect(unlisted.request).not.toHaveBeenCalled();
  });
});

function opened(
  interactionId: string,
  request: Extract<Fact, { type: "interaction.opened" }>["data"]["request"]
): Fact {
  return {
    data: { interactionId, request, subject: { turnId: "turn-1" } },
    scope: { turnId: "turn-1" },
    type: "interaction.opened",
  };
}

function settledReply(output: CallSettled["data"]["output"]): CallSettled {
  return {
    data: { callId: "call-reply", outcome: "completed", output },
    scope: { runId: "run-1", turnId: "turn-1" },
    type: "call.settled",
  };
}
