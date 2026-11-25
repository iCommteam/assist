import type * as Eve from "eve";
import type * as EveInstructions from "eve/instructions";
import type * as EveTools from "eve/tools";
import type { ToolContext, ToolDefinition } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleAccountSummary } from "@db/services/connectors/google";
import {
  dynamicContextFor,
  dynamicTool,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { toolContextFor } from "@tests/helpers/tool-context";
import { untrustedNotice } from "@agent/lib/google/content";
import { sitePrincipal } from "@agent/lib/site-principal";
import { googleRequestedScopes } from "@shared/connectors/google/scopes";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";

// A sentinel access token: it must reach the fake Google client and nothing
// else, neither a result, an error nor the instructions.
const accessToken = "ya29.sentinel-access-token-0123456789";

// The parts of Google's answers and requests these tests read.
interface Answer<T> {
  readonly data: T;
}
interface FakeCredentials {
  readonly access_token?: string;
}
interface MailMessage {
  readonly id?: string;
  readonly labelIds?: readonly string[];
  readonly payload?: {
    readonly headers?: readonly {
      readonly name: string;
      readonly value: string;
    }[];
  };
  readonly snippet?: string;
  readonly threadId?: string;
}
interface CalendarEvent {
  readonly id?: string;
  readonly summary?: string;
}
interface DriveFile {
  readonly id?: string;
  readonly mimeType?: string;
  readonly name?: string;
}

const mocks = vi.hoisted(() => {
  class FakeOAuth2 {
    credentials: FakeCredentials = {};
    setCredentials(credentials: FakeCredentials) {
      this.credentials = credentials;
    }
  }
  const auths: FakeOAuth2[] = [];
  return {
    FakeOAuth2,
    account:
      vi.fn<
        (scope: AccessScope) => Promise<GoogleAccountSummary | undefined>
      >(),
    auths,
    calendar: {
      events: {
        get: vi.fn<
          (request: {
            readonly calendarId: string;
            readonly eventId: string;
          }) => Promise<Answer<CalendarEvent>>
        >(),
        insert: vi.fn<
          (request: {
            readonly calendarId: string;
            readonly requestBody: {
              readonly attendees: readonly { readonly email: string }[];
              readonly id: string;
              readonly summary: string;
            };
            readonly sendUpdates: string;
          }) => Promise<Answer<CalendarEvent>>
        >(),
        list: vi.fn<() => Promise<Answer<null>>>(),
      },
      freebusy: { query: vi.fn<() => Promise<Answer<null>>>() },
    },
    clientId: vi.fn<() => string | undefined>(),
    drive: {
      files: {
        export: vi.fn<() => Promise<Answer<string>>>(),
        get: vi.fn<
          (request: { readonly fileId: string }) => Promise<Answer<DriveFile>>
        >(),
        list: vi.fn<
          (request: {
            readonly q: string;
            readonly supportsAllDrives: boolean;
          }) => Promise<Answer<{ readonly files: readonly DriveFile[] }>>
        >(),
      },
    },
    gmail: {
      users: {
        drafts: {
          create: vi.fn<() => Promise<Answer<{ readonly id?: string }>>>(),
        },
        messages: {
          get: vi.fn<
            (request: { readonly id: string }) => Promise<Answer<MailMessage>>
          >(),
          list: vi.fn<
            (request: {
              readonly q: string;
            }) => Promise<
              Answer<{ readonly messages?: readonly MailMessage[] }>
            >
          >(),
          send: vi.fn<
            (request: {
              readonly requestBody: {
                readonly raw: string;
                readonly threadId?: string;
              };
              readonly userId: string;
            }) => Promise<Answer<MailMessage>>
          >(),
        },
        threads: {
          get: vi.fn<
            (request: {
              readonly id: string;
            }) => Promise<
              Answer<{ readonly messages?: readonly MailMessage[] }>
            >
          >(),
        },
      },
    },
    sheets: {
      spreadsheets: {
        get: vi.fn<
          (request: { readonly spreadsheetId: string }) => Promise<
            Answer<{
              readonly sheets: readonly {
                readonly properties: { readonly title: string };
              }[];
            }>
          >
        >(),
        values: {
          batchGet: vi.fn<
            (request: {
              readonly ranges: readonly string[];
              readonly spreadsheetId: string;
            }) => Promise<
              Answer<{
                readonly valueRanges: readonly {
                  readonly values: readonly (readonly string[])[];
                }[];
              }>
            >
          >(),
        },
      },
    },
  };
});

vi.mock("eve", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof Eve>())
);
vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);
vi.mock("eve/instructions", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveInstructions>())
);
vi.mock("@shared/environment", () => ({
  env: {
    BETTER_AUTH_URL: "https://assist.example",
    get GOOGLE_CLIENT_ID() {
      return mocks.clientId();
    },
    get GOOGLE_CLIENT_SECRET() {
      return mocks.clientId() === undefined ? undefined : "client-secret";
    },
  },
}));
vi.mock("@db/services/connectors/google", () => ({
  googleAccountOf: mocks.account,
}));
interface ClientOptions {
  readonly auth: InstanceType<typeof mocks.FakeOAuth2>;
}
function recordAuth(options: ClientOptions) {
  mocks.auths.push(options.auth);
}
vi.mock("@googleapis/gmail", () => ({
  auth: { OAuth2: mocks.FakeOAuth2 },
  gmail: (options: ClientOptions) => {
    recordAuth(options);
    return mocks.gmail;
  },
}));
vi.mock("@googleapis/calendar", () => ({
  calendar: (options: ClientOptions) => {
    recordAuth(options);
    return mocks.calendar;
  },
}));
vi.mock("@googleapis/drive", () => ({
  drive: (options: ClientOptions) => {
    recordAuth(options);
    return mocks.drive;
  },
}));
vi.mock("@googleapis/sheets", () => ({
  sheets: (options: ClientOptions) => {
    recordAuth(options);
    return mocks.sheets;
  },
}));

const { default: gmail } = await import("@agent/tools/gmail");
const { default: calendar } = await import("@agent/tools/calendar");
const { default: drive } = await import("@agent/tools/drive");
const { default: googleInstructions } =
  await import("@agent/instructions/40-google");
const { googleAuth, googleAuthOptions } =
  await import("@agent/lib/google/auth");
const { googleModes } = await import("@agent/lib/google/offer");

const member = accessScopeForUser("better-auth:user-1");
const memberPrincipal = {
  attributes: {
    conversationChannel: "eve",
    email: "member@icommteam.com",
    workspaceId: member.workspaceId,
  },
  authenticator: "authjs",
  principalId: member.userId,
  principalType: "user",
};
const webChat = { current: memberPrincipal, initiator: memberPrincipal };

const connected: GoogleAccountSummary = {
  connectedAt: "2026-11-25T08:00:00.000Z",
  email: "member@icommteam.com",
  needsReconnect: false,
  scopes: [...googleRequestedScopes],
};

const sessionsWithoutGoogle = {
  "a scheduled run": principalOf("scheduled-worker"),
  "a site chat": sitePrincipal(
    {
      chat: "00000000-0000-4000-8000-0000000000c1",
      op: "chat.create",
      site: "teemiq",
      siteUser: "teemiq-user-1",
    },
    "member@icommteam.com",
    member
  ),
  "a site task": {
    ...principalOf("assist-site"),
    attributes: { site: "teemiq", workspaceId: member.workspaceId },
  },
  "a scheduled report": principalOf("scheduled-result"),
  "a WhatsApp chat": principalOf("assist-whatsapp"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auths.length = 0;
  mocks.clientId.mockReturnValue("client.apps.googleusercontent.com");
  mocks.account.mockResolvedValue(connected);
});

describe("which sessions are offered Google", () => {
  it("lists the web chat's mode alone, as the one place WhatsApp's joins at merge", () => {
    expect(googleModes).toEqual(["interactive"]);
  });

  it("offers no Google tool while Google is not set up", async () => {
    mocks.clientId.mockReturnValue(undefined);
    expect(await offered(webChat)).toEqual([]);
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it("offers no Google tool to a member who has not connected an account", async () => {
    mocks.account.mockResolvedValue(undefined);
    expect(await offered(webChat)).toEqual([]);
    expect(mocks.account).toHaveBeenCalledWith(member);
  });

  it("offers a connected member every tool whose scope Google granted", async () => {
    expect(await offered(webChat)).toEqual([
      "calendar_create_event",
      "calendar_free_busy",
      "calendar_list_events",
      "drive_read_file",
      "drive_search",
      "gmail_create_draft",
      "gmail_read_thread",
      "gmail_search",
      "gmail_send",
    ]);

    mocks.account.mockResolvedValue({
      ...connected,
      scopes: [
        "openid",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
    });
    expect(await offered(webChat)).toEqual([
      "drive_read_file",
      "drive_search",
      "gmail_read_thread",
      "gmail_search",
    ]);
  });

  it("keeps the tools of an account Google stopped accepting, so a call asks to connect again", async () => {
    mocks.account.mockResolvedValue({ ...connected, needsReconnect: true });
    expect(await offered(webChat)).toHaveLength(9);
  });

  it("never offers a member's Google account to a site task, a site chat, WhatsApp or a scheduled run", async () => {
    for (const [session, principal] of Object.entries(sessionsWithoutGoogle)) {
      const auth = { current: principal, initiator: principal };
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each session is checked on its own.
      expect({ offered: await offered(auth), session }).toEqual({
        offered: [],
        session,
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each session is checked on its own.
      expect({ instructions: await instructionsFor(auth), session }).toEqual({
        instructions: null,
        session,
      });
    }
    // A member's own message into a site's task keeps the site's session.
    const siteTask = sessionsWithoutGoogle["a site task"];
    expect(
      await offered({ current: memberPrincipal, initiator: siteTask })
    ).toEqual([]);
    expect(mocks.account).not.toHaveBeenCalled();
  });
});

describe("approvals", () => {
  it("asks the member to approve every send and every new event, and nothing else", async () => {
    const tools = await toolsFor(webChat);
    const approved = Object.entries(tools)
      .filter(([, tool]) => tool.approval !== undefined)
      .map(([name]) => name)
      .toSorted();
    expect(approved).toEqual(["calendar_create_event", "gmail_send"]);

    for (const name of approved) {
      const approval = approvalOf(tools[name]);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each tool is checked on its own.
      const asked = await approval.request(approvalContext(webChat, name));
      expect({ asked, name }).toEqual({ asked: "user-approval", name });
    }
  });

  it("refuses a send or a new event outright in a session Google is not offered in", async () => {
    const tools = await toolsFor(webChat);
    const siteTask = sessionsWithoutGoogle["a site task"];
    for (const name of ["calendar_create_event", "gmail_send"]) {
      const approval = approvalOf(tools[name]);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each tool is checked on its own.
      const asked = await approval.request(
        approvalContext({ current: siteTask, initiator: siteTask }, name)
      );
      expect(asked).toMatchObject({ type: "denied" });
    }
  });

  it("names the recipients and subject of a send, and the time and guests of an event", async () => {
    const tools = await toolsFor(webChat);
    expect(
      approvalOf(tools.gmail_send).prompt?.({
        callId: "call-1",
        input: {
          bcc: ["archive@icommteam.com"],
          body: "Hi Dana,\nthe October invoice is attached.",
          cc: ["finance@icommteam.com"],
          subject: "October invoice",
          to: ["dana@supplier.example"],
        },
        toolName: "gmail_send",
      })
    ).toBe(
      "Send “October invoice” to dana@supplier.example, cc finance@icommteam.com, bcc archive@icommteam.com from your Gmail? “Hi Dana, the October invoice is attached.”"
    );
    expect(
      approvalOf(tools.calendar_create_event).prompt?.({
        callId: "call-2",
        input: {
          attendees: ["vadim@icommteam.com"],
          calendarId: "primary",
          end: "2026-12-02T11:00:00+02:00",
          start: "2026-12-02T10:00:00+02:00",
          summary: "Supplier review",
          timeZone: "Asia/Jerusalem",
        },
        toolName: "calendar_create_event",
      })
    ).toBe(
      "Create “Supplier review” on Wed, 2 Dec 2026, 10:00–11:00 (Asia/Jerusalem) and invite vadim@icommteam.com in your Google Calendar?"
    );
  });
});

describe("Google calls", () => {
  it("sends the approved email as written, with the member's own token given to Google alone", async () => {
    mocks.gmail.users.messages.send.mockResolvedValue({
      data: { id: "message-1", threadId: "thread-1" },
    });
    const ctx = callContext(webChat, "call-send");

    const result = await dynamicTool(await gmailTools(), "gmail_send").execute(
      {
        bcc: [],
        body: "שלום, the invoice is attached.",
        cc: [],
        inReplyTo: "<original@supplier.example>",
        subject: "חשבונית October",
        threadId: "thread-1",
        to: ["dana@supplier.example"],
      },
      ctx
    );

    expect(result).toEqual({
      messageId: "message-1",
      sent: true,
      threadId: "thread-1",
    });
    expect(ctx.getToken).toHaveBeenCalledWith(googleAuth, googleAuthOptions);
    expect(mocks.auths.map((auth) => auth.credentials)).toEqual([
      { access_token: accessToken },
    ]);
    const [request] = mocks.gmail.users.messages.send.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      requestBody: { threadId: "thread-1" },
      userId: "me",
    });
    const raw = Buffer.from(
      request?.requestBody.raw ?? "",
      "base64url"
    ).toString("utf8");
    const [head = "", body = ""] = raw.split("\r\n\r\n");
    const headers = head.split("\r\n");
    expect(headers[2]).toMatch(
      /^Message-ID: <assist-[0-9a-f]{40}@assist\.icommteam\.com>$/u
    );
    expect(headers.toSpliced(2, 1)).toEqual([
      "To: dana@supplier.example",
      `Subject: =?UTF-8?B?${Buffer.from("חשבונית October").toString("base64")}?=`,
      "In-Reply-To: <original@supplier.example>",
      "References: <original@supplier.example>",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(body.replaceAll("\r\n", ""), "base64").toString()).toBe(
      "שלום, the invoice is attached."
    );
    expect(JSON.stringify(result)).not.toContain(accessToken);
  });

  it("keeps Google's own error, and the token inside it, away from the model", async () => {
    mocks.gmail.users.threads.get.mockRejectedValue(
      Object.assign(new Error(`Request failed with Bearer ${accessToken}`), {
        config: { headers: { Authorization: `Bearer ${accessToken}` } },
        response: {
          data: { error: { message: "Requested entity was not found." } },
          status: 404,
        },
      })
    );

    const failure = await Promise.resolve(
      dynamicTool(await gmailTools(), "gmail_read_thread").execute(
        { threadId: "thread-x" },
        callContext(webChat, "call-read")
      )
    ).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message: "Gmail answered 404: Requested entity was not found.",
    });
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain(accessToken);
  });

  it("asks the member to connect Google again when Google rejects the token", async () => {
    mocks.gmail.users.messages.list.mockRejectedValue({
      response: { status: 401 },
    });
    const ctx = callContext(webChat, "call-search");

    await expect(
      dynamicTool(await gmailTools(), "gmail_search").execute(
        { maxResults: 5, query: "invoice" },
        ctx
      )
    ).rejects.toThrow("sign in again");
    expect(ctx.requireAuth).toHaveBeenCalledWith(googleAuth, googleAuthOptions);
  });

  it("labels mail as other people's text and drops what looks like a credential", async () => {
    mocks.gmail.users.messages.list.mockResolvedValue({
      data: { messages: [{ id: "m1" }] },
    });
    mocks.gmail.users.messages.get.mockResolvedValue({
      data: {
        id: "m1",
        labelIds: ["UNREAD"],
        payload: {
          headers: [
            { name: "From", value: "billing@supplier.example" },
            { name: "Subject", value: "Your invoice" },
          ],
        },
        snippet: "Your API key is sk-proj-abcdefghijklmnop1234 keep it safe",
        threadId: "t1",
      },
    });

    const result = await dynamicTool(
      await gmailTools(),
      "gmail_search"
    ).execute(
      { maxResults: 5, query: "invoice" },
      callContext(webChat, "call-search")
    );

    expect(result).toMatchObject({
      messages: [
        {
          from: "billing@supplier.example",
          id: "m1",
          snippet: "Your API key is [api key removed] keep it safe",
          subject: "Your invoice",
          threadId: "t1",
          unread: true,
        },
      ],
    });
    expect(result).toHaveProperty("notice", untrustedNotice);
  });

  it("creates the approved event once, finding it again when the same call runs twice", async () => {
    mocks.calendar.events.insert.mockRejectedValue({
      response: { status: 409 },
    });
    mocks.calendar.events.get.mockResolvedValue({
      data: { id: "event-1", summary: "Supplier review" },
    });
    const input = {
      attendees: ["vadim@icommteam.com"],
      calendarId: "primary",
      end: "2026-12-02T11:00:00+02:00",
      start: "2026-12-02T10:00:00+02:00",
      summary: "Supplier review",
      timeZone: "Asia/Jerusalem",
    };

    const result = await dynamicTool(
      await calendarTools(),
      "calendar_create_event"
    ).execute(input, callContext(webChat, "call-event"));

    const [request] = mocks.calendar.events.insert.mock.calls[0] ?? [];
    const eventId = request?.requestBody.id ?? "";
    expect(eventId).toMatch(/^[0-9a-f]{32}$/u);
    expect(request).toMatchObject({
      calendarId: "primary",
      requestBody: {
        attendees: [{ email: "vadim@icommteam.com" }],
        id: eventId,
        summary: "Supplier review",
      },
      sendUpdates: "all",
    });
    expect(mocks.calendar.events.get).toHaveBeenCalledWith(
      { calendarId: "primary", eventId },
      expect.anything()
    );
    expect(result).toMatchObject({
      created: true,
      event: { id: "event-1", summary: "Supplier review" },
    });
  });

  it("quotes the member's words into Drive's search, so they cannot widen it", async () => {
    mocks.drive.files.list.mockResolvedValue({ data: { files: [] } });

    await dynamicTool(await driveTools(), "drive_search").execute(
      {
        kind: "spreadsheet",
        maxResults: 5,
        query: "o'brien' or name contains '",
      },
      callContext(webChat, "call-drive")
    );

    expect(mocks.drive.files.list.mock.calls[0]?.[0]).toMatchObject({
      q: "fullText contains 'o\\'brien\\' or name contains \\'' and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'",
      supportsAllDrives: true,
    });
  });

  it("reads a Google Sheet's tabs as tab-separated rows", async () => {
    mocks.drive.files.get.mockResolvedValue({
      data: {
        id: "sheet-1",
        mimeType: "application/vnd.google-apps.spreadsheet",
        name: "Suppliers",
      },
    });
    mocks.sheets.spreadsheets.get.mockResolvedValue({
      data: { sheets: [{ properties: { title: "It's 2026" } }] },
    });
    mocks.sheets.spreadsheets.values.batchGet.mockResolvedValue({
      data: {
        valueRanges: [
          {
            values: [
              ["Name", "Site"],
              ["OpenAI", "openai.com"],
            ],
          },
        ],
      },
    });

    const result = await dynamicTool(
      await driveTools(),
      "drive_read_file"
    ).execute(
      { fileId: "sheet-1", maxCharacters: 1_000 },
      callContext(webChat, "call-sheet")
    );

    expect(
      mocks.sheets.spreadsheets.values.batchGet.mock.calls[0]?.[0]
    ).toMatchObject({
      ranges: ["'It''s 2026'!A1:Z200"],
      spreadsheetId: "sheet-1",
    });
    expect(result).toMatchObject({
      readable: true,
      text: "# It's 2026\nName\tSite\nOpenAI\topenai.com",
      truncated: false,
    });
  });

  it("refuses a call that reached a session Google is not offered in", async () => {
    const tools = await gmailTools();
    const siteTask = sessionsWithoutGoogle["a site task"];
    await expect(
      dynamicTool(tools, "gmail_search").execute(
        { maxResults: 5, query: "invoice" },
        callContext({ current: siteTask, initiator: siteTask }, "call-x")
      )
    ).rejects.toThrow("Google is not available in this conversation.");
    expect(mocks.gmail.users.messages.list).not.toHaveBeenCalled();
  });
});

describe("Google instructions", () => {
  it("tells a member who has not connected where to connect, and says nothing while Google is not set up", async () => {
    mocks.account.mockResolvedValue(undefined);
    expect(await instructionsFor(webChat)).toContain(
      "connect Google on assist's Workspace page (https://assist.example/#connectors)"
    );
    mocks.clientId.mockReturnValue(undefined);
    expect(await instructionsFor(webChat)).toBeNull();
  });

  it("names the connected account and what Google granted, and asks before sending or creating", async () => {
    mocks.account.mockResolvedValue({
      ...connected,
      scopes: connected.scopes.filter(
        (scope) => !scope.endsWith("gmail.compose")
      ),
    });
    const content = await instructionsFor(webChat);
    expect(content).toContain("member@icommteam.com");
    expect(content).toContain("`gmail_search` and `gmail_read_thread`");
    expect(content).toContain(
      "Gmail: write drafts, and send mail you approve was not granted"
    );
    expect(content).toContain(
      "Each send and each new event then waits for the member's own Approve in the chat"
    );
    expect(content).not.toContain(accessToken);
  });
});

function principalOf(authenticator: string) {
  return {
    attributes: { workspaceId: member.workspaceId },
    authenticator,
    principalId: member.userId,
    principalType: "user",
  };
}

type Auth = Eve.DynamicContext["session"]["auth"];

async function toolsFor(auth: Auth) {
  const context = dynamicContextFor({ auth });
  const resolved = await Promise.all(
    [calendar, drive, gmail].map((definition) =>
      evaluateDynamic(definition, context)
    )
  );
  return Object.fromEntries(
    resolved.flatMap((tools) =>
      tools && !("inputSchema" in tools)
        ? Object.keys(tools).map((name) => [name, dynamicTool(tools, name)])
        : []
    )
  );
}

async function offered(auth: Auth) {
  return Object.keys(await toolsFor(auth)).toSorted();
}

async function gmailTools() {
  return evaluateDynamic(gmail, dynamicContextFor({ auth: webChat }));
}

async function calendarTools() {
  return evaluateDynamic(calendar, dynamicContextFor({ auth: webChat }));
}

async function driveTools() {
  return evaluateDynamic(drive, dynamicContextFor({ auth: webChat }));
}

async function instructionsFor(auth: Auth) {
  const instructions = await evaluateDynamic(
    googleInstructions,
    dynamicContextFor({ auth })
  );
  if (instructions === null) return null;
  return "content" in instructions ? instructions.content : null;
}

function approvalOf(tool: ToolDefinition | undefined) {
  const approval = tool?.approval;
  if (!approval || !("request" in approval)) {
    throw new Error("Expected an approval configuration.");
  }
  return approval;
}

function approvalContext(auth: Auth, toolName: string): ApprovalContext {
  const { abortSignal, session } = toolContextFor({
    auth,
    callId: "call-approval",
    sessionId: "session-1",
  });
  return {
    abortSignal,
    callId: "call-approval",
    async getSandbox() {
      throw new Error("An approval policy here needs no sandbox.");
    },
    session,
    toolName,
  };
}

function callContext(auth: Auth, callId: string) {
  return {
    ...toolContextFor({ auth, callId, sessionId: "session-1" }),
    getToken: vi.fn<ToolContext["getToken"]>(async () => ({
      token: accessToken,
    })),
    requireAuth: vi.fn<ToolContext["requireAuth"]>(() => {
      throw new Error("sign in again");
    }),
  };
}
