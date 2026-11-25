import {
  emptySessionView,
  foldEvents,
  interactions,
  type ReceivedEvent,
} from "eve/events";
import { z } from "zod";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";

// What a site's chat UI reads: a small, versioned NDJSON of the chat's
// conversation, folded from eve's events by allow-list. Tool inputs and
// outputs never leave assist, except the fields a site acts on: the id of a
// look or fetch it started, the supplier (and its line) a look or a fetch
// found no saved account for, and a proposed pairing. Every line carries the version, and
// every line but a heartbeat the eve line it came from, so a reader that lost
// its connection resumes after the last one it read.
const chatStreamVersion = 1;

const resultOpen = "<teemiq-result>";
const resultClose = "</teemiq-result>";
const maxQuestionLength = 1000;
const maxWhyLength = 500;
const maxSupplierNameLength = 200;
const maxGuessedSiteLength = 300;
const maxAlsoHosts = 3;

// What the site posted as the outcome of a look or a fetch, framed so the
// agent reads it as a result, never as the person's words. A person's text
// and the result's own text can neither open nor close the frame.
export function resultMessage(text: string) {
  return `${resultOpen}\n${unframed(text)}\n${resultClose}`;
}

export function personMessage(text: string) {
  return unframed(text);
}

function unframed(text: string) {
  return text.replaceAll(/<(\/?)teemiq-result/giu, "‹$1teemiq-result");
}

// Fixed labels by tool name; nothing the model wrote reaches the site.
const progressLabels = new Map([
  ["teemiq__finance_fetch_invoice", "Starting a fetch"],
  ["teemiq__finance_site_look", "Starting a look"],
  ["web_search", "Searching the web"],
]);
const fetchTools = new Set([
  "teemiq__finance_fetch_invoice",
  "teemiq__finance_site_look",
]);
const proposalTool = "teemiq__finance_propose_pairing";
const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w:.-]+$/u);
const fetchOutputSchema = z.looseObject({ fetchId: idSchema });
// A look or a fetch TEEMIQ did not start because the supplier has no saved
// account, so the site shows the person a form to add one. Only these fields
// are read: the supplier's name and guessed site, each as one bounded line;
// the line it was for, as an id; and up to three other hosts the guess said
// its billing uses, each a bare host name.
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/u);
const needsAccountOutputSchema = z.looseObject({
  needs_account: z.looseObject({
    alsoHosts: z.array(z.unknown()).optional().catch(undefined),
    guessedSite: z.string().optional().catch(undefined),
    supplierName: z.string(),
    txnId: idSchema.optional().catch(undefined),
  }),
});
const proposalOutputSchema = z.looseObject({
  documentId: idSchema,
  txnId: idSchema,
  why: z.string().trim().min(1),
});

const callRequestedSchema = z.object({
  data: z.object({
    callId: z.string().min(1),
    capability: z.object({ name: z.string().min(1) }),
  }),
  type: z.literal("call.requested"),
});
const callSettledSchema = z.object({
  data: z.object({
    callId: z.string().min(1),
    outcome: z.literal("completed"),
    output: z.json(),
  }),
  type: z.literal("call.settled"),
});
const deliveryConsumedSchema = z.object({
  data: z.object({
    parts: z.array(z.looseObject({ kind: z.string(), text: z.string() })),
  }),
  type: z.literal("delivery.consumed"),
});
const questionOpenedSchema = z.object({
  data: z.object({
    interactionId: z.string().min(1),
    request: z.object({
      kind: z.literal("question"),
      options: z
        .array(z.object({ id: z.string().min(1), label: z.string() }))
        .optional(),
      prompt: z.string(),
    }),
  }),
  type: z.literal("interaction.opened"),
});
const turnSettledSchema = z.object({
  data: z.object({
    outcome: z.enum(["completed", "failed", "cancelled"]),
    turnId: z.string().min(1),
  }),
  type: z.literal("turn.settled"),
});

// A look or a fetch found no saved account to use; built a field at a time.
interface AccountLine {
  alsoHosts?: readonly string[];
  guessedSite?: string;
  supplierName: string;
  txnId?: string;
  type: "account";
}

type ChatLine =
  | {
      readonly from: "assistant" | "person" | "result";
      readonly text: string;
      readonly type: "message";
    }
  | { readonly label: string; readonly type: "progress" }
  | {
      readonly id: string;
      readonly options: readonly { id: string; label: string }[];
      readonly text: string;
      readonly type: "question";
    }
  | { readonly fetchId: string; readonly type: "fetch" }
  | Readonly<AccountLine>
  | {
      readonly documentId: string;
      readonly txnId: string;
      readonly type: "proposal";
      readonly why: string;
    }
  | { readonly type: "done" }
  | { readonly code: ChatErrorCode; readonly type: "error" };

type ChatErrorCode =
  | "cancelled"
  | "ended"
  | "failed"
  | "needs_person"
  | "usage_limit";

export function heartbeatLine() {
  return { type: "heartbeat", v: chatStreamVersion } as const;
}

type StampedLine = ChatLine & { readonly cursor: number; readonly v: 1 };

// Every line a site reads.
export type ChatStreamLine = StampedLine | ReturnType<typeof heartbeatLine>;

// Folds a chat's events in order, from the session's first, into the lines a
// site reads. It keeps the session view, so a turn's end can say why it
// stopped, and each call's tool name.
export function chatFold() {
  let view = emptySessionView();
  const toolOfCall = new Map<string, string>();
  return (event: ReceivedEvent) => {
    view = foldEvents(view, [event]);
    const cursor = event.meta.position.line;
    const stamped: StampedLine[] = [];
    for (const line of linesOf(event, toolOfCall, () => view)) {
      stamped.push({ ...line, cursor, v: chatStreamVersion });
    }
    return stamped;
  };
}

function linesOf(
  event: ReceivedEvent,
  toolOfCall: Map<string, string>,
  view: () => Parameters<typeof interactions>[0]
): ChatLine[] {
  switch (event.type) {
    case "delivery.consumed":
      return deliveredLines(event);
    case "call.requested": {
      const call = callRequestedSchema.safeParse(event);
      if (!call.success) return [];
      const { callId, capability } = call.data.data;
      toolOfCall.set(callId, capability.name);
      const label = progressLabels.get(capability.name);
      return label ? [{ label, type: "progress" }] : [];
    }
    case "call.settled":
      return settledLines(event, toolOfCall);
    case "interaction.opened": {
      const question = questionOpenedSchema.safeParse(event);
      if (!question.success) return [];
      const { interactionId, request } = question.data.data;
      return [
        {
          id: interactionId,
          options: (request.options ?? []).map(({ id, label }) => ({
            id,
            label: plainLine(label, 200),
          })),
          text: plainText(request.prompt, maxQuestionLength),
          type: "question",
        },
      ];
    }
    case "turn.settled": {
      const settled = turnSettledSchema.safeParse(event);
      if (!settled.success) return [];
      const { outcome, turnId } = settled.data.data;
      if (outcome === "completed") return [{ type: "done" }];
      if (outcome === "failed") return [{ code: "failed", type: "error" }];
      return [{ code: stoppedCode(view(), turnId), type: "error" }];
    }
    case "session.ended":
      return [{ code: "ended", type: "error" }];
    default:
      return [];
  }
}

function deliveredLines(event: ReceivedEvent): ChatLine[] {
  const delivered = deliveryConsumedSchema.safeParse(event);
  if (!delivered.success) return [];
  const text = delivered.data.data.parts
    .filter(({ kind }) => kind === "text")
    .map(({ text: part }) => part)
    .join("\n");
  if (text.trim() === "") return [];
  if (text.startsWith(`${resultOpen}\n`) && text.endsWith(`\n${resultClose}`)) {
    return [
      {
        from: "result",
        text: text.slice(resultOpen.length + 1, -(resultClose.length + 1)),
        type: "message",
      },
    ];
  }
  return [{ from: "person", text, type: "message" }];
}

function settledLines(
  event: ReceivedEvent,
  toolOfCall: Map<string, string>
): ChatLine[] {
  const settled = callSettledSchema.safeParse(event);
  if (!settled.success) return [];
  const { callId, output } = settled.data.data;
  const tool = toolOfCall.get(callId);
  if (tool === "send_message") {
    const message = sendMessageOutputSchema.safeParse(output);
    if (!message.success) return [];
    const text =
      message.data.kind === "link"
        ? message.data.url
        : [
            message.data.text,
            ...(message.data.attachments ?? []).map(({ url }) => url),
          ]
            .filter((line) => line !== undefined)
            .join("\n");
    return [{ from: "assistant", text, type: "message" }];
  }
  if (tool !== undefined && fetchTools.has(tool)) {
    const answer = structured(output);
    const needsAccount = needsAccountOutputSchema.safeParse(answer);
    if (needsAccount.success) return accountLines(needsAccount.data);
    const started = fetchOutputSchema.safeParse(answer);
    return started.success
      ? [{ fetchId: started.data.fetchId, type: "fetch" }]
      : [];
  }
  if (tool === proposalTool) {
    const proposal = proposalOutputSchema.safeParse(structured(output));
    if (!proposal.success) return [];
    const { documentId, txnId, why } = proposal.data;
    return [
      {
        documentId,
        txnId,
        type: "proposal",
        why: plainLine(why, maxWhyLength),
      },
    ];
  }
  return [];
}

// A supplier name that is empty once made one line names nobody, so it
// yields no line; a guessed site, a line id or other hosts that do not parse
// are left out, and the line stays.
function accountLines({
  needs_account: { alsoHosts, guessedSite, supplierName, txnId },
}: z.infer<typeof needsAccountOutputSchema>): ChatLine[] {
  const name = plainLine(supplierName, maxSupplierNameLength);
  if (name === "") return [];
  const site = plainLine(guessedSite ?? "", maxGuessedSiteLength);
  const hosts = [
    ...new Set(
      (alsoHosts ?? []).flatMap((host) => {
        const parsed = hostSchema.safeParse(host);
        return parsed.success ? [parsed.data] : [];
      })
    ),
  ].slice(0, maxAlsoHosts);
  const line: AccountLine = { supplierName: name, type: "account" };
  if (hosts.length > 0) line.alsoHosts = hosts;
  if (site !== "") line.guessedSite = site;
  if (txnId !== undefined) line.txnId = txnId;
  return [line];
}

// A connection tool's output is its structured content, or its text, which
// may be JSON.
const jsonTextSchema = z.string().transform((text, context) => {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    context.addIssue({ code: "custom", message: "The text is not JSON." });
    return z.NEVER;
  }
});
const toolOutputSchema = z.union([jsonTextSchema, z.json()]);

function structured(output: z.core.util.JSONType) {
  return toolOutputSchema.parse(output);
}

// A turn cancelled at the usage limit's prompt, which the chat answers no,
// or at another request its site cannot answer, or by a cancel.
function stoppedCode(
  view: Parameters<typeof interactions>[0],
  turnId: string
): ChatErrorCode {
  const asked = interactions(view).filter(
    (interaction) =>
      interaction.turnId === turnId && interaction.request.kind !== "question"
  );
  if (asked.some(({ request }) => request.kind === "budget")) {
    return "usage_limit";
  }
  return asked.length > 0 ? "needs_person" : "cancelled";
}

function plainText(text: string, max: number) {
  const clean = text.replaceAll(/[\p{Cc}\p{Cf}]/gu, (character) =>
    character === "\n" ? "\n" : " "
  );
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function plainLine(text: string, max: number) {
  const line = text
    .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
