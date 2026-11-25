import { createHash } from "node:crypto";
import { gmail, type gmail_v1 } from "@googleapis/gmail";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";
import { z } from "zod";
import { withGoogle } from "@agent/lib/google/client";
import { boundedText, untrustedNotice } from "@agent/lib/google/content";
import { googleToolsFor } from "@agent/lib/google/tools";
import { requireGoogleScope } from "@agent/lib/google/offer";

type GmailMessage = gmail_v1.Schema$Message;
type GmailPart = gmail_v1.Schema$MessagePart;

const service = "Gmail";
const metadataHeaders = ["From", "To", "Cc", "Subject", "Date", "Message-ID"];

const gmailSearch = defineTool({
  availableInSubagents: false,
  description:
    "Search the member's own Gmail with Gmail's search syntax (from:, to:, subject:, after:, has:attachment, is:unread, and words). Returns each match's sender, recipients, subject, date and snippet. Read a whole conversation with gmail_read_thread.",
  inputSchema: z.object({
    maxResults: z.number().int().min(1).max(25).default(10),
    query: z.string().trim().min(1).max(500),
  }),
  label: { start: ({ query }) => `Search Gmail for “${query}”` },
  async execute({ maxResults, query }, ctx) {
    requireGoogleScope(ctx);
    const messages = await withGmail(ctx, async (client) => {
      const listed = await client.users.messages.list(
        { maxResults, q: query, userId: "me" },
        { signal: ctx.abortSignal }
      );
      const ids = (listed.data.messages ?? []).flatMap(({ id }) =>
        id ? [id] : []
      );
      return Promise.all(
        ids.map(async (id) => {
          const { data } = await client.users.messages.get(
            { format: "metadata", id, metadataHeaders, userId: "me" },
            { signal: ctx.abortSignal }
          );
          return data;
        })
      );
    });
    return {
      messages: messages.map((message) =>
        Object.assign(messageHeaders(message), {
          snippet: boundedText(message.snippet ?? "", 300).text,
          unread: (message.labelIds ?? []).includes("UNREAD"),
        })
      ),
      notice: untrustedNotice,
    };
  },
});

const gmailReadThread = defineTool({
  availableInSubagents: false,
  description:
    "Read one Gmail conversation by its threadId from gmail_search: each message's headers, plain text and attachment names. Attachments themselves are not opened.",
  inputSchema: z.object({ threadId: z.string().trim().min(1).max(200) }),
  label: { start: () => "Read a Gmail conversation" },
  async execute({ threadId }, ctx) {
    requireGoogleScope(ctx);
    const thread = await withGmail(ctx, async (client) => {
      const { data } = await client.users.threads.get(
        { format: "full", id: threadId, userId: "me" },
        { signal: ctx.abortSignal }
      );
      return data;
    });
    const messages = (thread.messages ?? []).slice(-20);
    return {
      messages: messages.map((message) => {
        const body = boundedText(plainText(message.payload), 8_000);
        return Object.assign(messageHeaders(message), {
          attachments: attachmentsOf(message.payload),
          body: body.text,
          bodyTruncated: body.truncated,
        });
      }),
      notice: untrustedNotice,
      olderMessagesLeftOut: Math.max(
        0,
        (thread.messages?.length ?? 0) - messages.length
      ),
      threadId: thread.id ?? threadId,
    };
  },
});

const draftInputSchema = z.object({
  bcc: z.array(z.email()).max(20).default([]),
  body: z.string().min(1).max(50_000),
  cc: z.array(z.email()).max(20).default([]),
  inReplyTo: z
    .string()
    .trim()
    .max(998)
    .optional()
    .describe("The Message-ID header of the message this one answers."),
  subject: z.string().trim().min(1).max(500),
  threadId: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("The thread of the message this one answers."),
  to: z.array(z.email()).min(1).max(20),
});

type DraftInput = z.infer<typeof draftInputSchema>;

const gmailCreateDraft = defineTool({
  availableInSubagents: false,
  description:
    "Save a plain-text email as a draft in the member's own Gmail. Nothing is sent: the member finds it in Gmail's Drafts. For a reply, pass the threadId and the Message-ID of the message it answers.",
  inputSchema: draftInputSchema,
  label: { start: ({ subject }) => `Draft “${subject}” in Gmail` },
  async execute(input, ctx) {
    requireGoogleScope(ctx);
    const draft = await withGmail(ctx, async (client) => {
      const { data } = await client.users.drafts.create(
        {
          requestBody: { message: outgoing(input, ctx) },
          userId: "me",
        },
        { signal: ctx.abortSignal }
      );
      return data;
    });
    return {
      draftId: draft.id ?? null,
      saved: true,
      threadId: draft.message?.threadId ?? null,
    };
  },
});

// Nothing leaves the mailbox without the member's yes: every call waits for
// their approval in the chat, which names the recipients and the subject.
const gmailSend = defineTool({
  availableInSubagents: false,
  description:
    "Send a plain-text email from the member's own Gmail. Show the member the exact recipients, subject and text first; the member then approves this call in the chat before anything is sent. For a reply, pass the threadId and the Message-ID of the message it answers.",
  inputSchema: draftInputSchema,
  approval: {
    prompt: ({ input }) => sendPrompt(input),
    request: (context) => approvalOf(context),
  },
  label: { start: ({ subject }) => `Send “${subject}” from Gmail` },
  async execute(input, ctx) {
    requireGoogleScope(ctx);
    const sent = await withGmail(ctx, async (client) => {
      const { data } = await client.users.messages.send(
        { requestBody: outgoing(input, ctx), userId: "me" },
        { signal: ctx.abortSignal }
      );
      return data;
    });
    return {
      messageId: sent.id ?? null,
      sent: true,
      threadId: sent.threadId ?? null,
    };
  },
});

export default defineDynamic((context) =>
  googleToolsFor(context, {
    gmail_create_draft: { ability: "gmail-write", tool: gmailCreateDraft },
    gmail_read_thread: { ability: "gmail-read", tool: gmailReadThread },
    gmail_search: { ability: "gmail-read", tool: gmailSearch },
    gmail_send: { ability: "gmail-write", tool: gmailSend },
  })
);

function approvalOf(context: Pick<ApprovalContext, "session">) {
  try {
    requireGoogleScope(context);
  } catch {
    return {
      reason: "Google is not available in this conversation.",
      type: "denied",
    } as const;
  }
  return "user-approval" as const;
}

// Every address is named, copies and blind copies included: the member
// approves exactly who receives the mail.
function sendPrompt(input: DraftInput) {
  const cc = input.cc.length > 0 ? `, cc ${input.cc.join(", ")}` : "";
  const bcc = input.bcc.length > 0 ? `, bcc ${input.bcc.join(", ")}` : "";
  return `Send “${excerpt(input.subject, 120)}” to ${input.to.join(", ")}${cc}${bcc} from your Gmail? “${excerpt(input.body, 240)}”`;
}

function excerpt(text: string, limit: number) {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

function withGmail<T>(
  ctx: ToolContext,
  call: (client: ReturnType<typeof gmail>) => Promise<T>
) {
  return withGoogle(ctx, service, (auth) =>
    call(gmail({ auth, version: "v1" }))
  );
}

// The raw RFC 5322 message Gmail sends or keeps as a draft. Every header
// value is one line; a subject outside ASCII is encoded (RFC 2047) and the
// text goes as base64 UTF-8. The Message-ID is derived from the session and
// the call, so a call that runs again sends the same message.
function outgoing(input: DraftInput, ctx: ToolContext) {
  const stableId = createHash("sha256")
    .update(`${ctx.session.id}:${ctx.callId}`)
    .digest("hex")
    .slice(0, 40);
  const headers = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
    ...(input.bcc.length > 0 ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: ${encodedHeader(input.subject)}`,
    `Message-ID: <assist-${stableId}@assist.icommteam.com>`,
    ...(input.inReplyTo
      ? [
          `In-Reply-To: ${oneLine(input.inReplyTo)}`,
          `References: ${oneLine(input.inReplyTo)}`,
        ]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(input.body, "utf8")
    .toString("base64")
    .replace(/.{1,76}/gu, "$&\r\n");
  const raw = Buffer.from(
    `${headers.join("\r\n")}\r\n\r\n${body}`,
    "utf8"
  ).toString("base64url");
  return input.threadId ? { raw, threadId: input.threadId } : { raw };
}

function oneLine(value: string) {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function encodedHeader(value: string) {
  const line = oneLine(value);
  // Printable ASCII is the only text a header carries unencoded.
  return /^[\x20-\x7e]*$/u.test(line)
    ? line
    : `=?UTF-8?B?${Buffer.from(line, "utf8").toString("base64")}?=`;
}

function header(message: GmailMessage, name: string) {
  return (
    message.payload?.headers?.find(
      (item) => item.name?.toLowerCase() === name.toLowerCase()
    )?.value ?? null
  );
}

function messageHeaders(message: GmailMessage) {
  return {
    cc: header(message, "Cc"),
    date: header(message, "Date"),
    from: header(message, "From"),
    id: message.id ?? null,
    messageId: header(message, "Message-ID"),
    subject: header(message, "Subject"),
    threadId: message.threadId ?? null,
    to: header(message, "To"),
  };
}

function plainText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const text = plainText(child);
    if (text) return text;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url")
      .toString("utf8")
      .replace(/<(?:style|script)[^>]*>[\s\S]*?<\/(?:style|script)>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }
  return "";
}

function attachmentsOf(part: GmailPart | undefined): {
  readonly filename: string;
  readonly mimeType: string | null;
  readonly size: number;
}[] {
  if (!part) return [];
  const own =
    part.filename && part.body?.attachmentId
      ? [
          {
            filename: part.filename,
            mimeType: part.mimeType ?? null,
            size: part.body.size ?? 0,
          },
        ]
      : [];
  return [...own, ...(part.parts ?? []).flatMap(attachmentsOf)];
}
