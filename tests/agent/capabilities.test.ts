import { readdirSync } from "node:fs";
import type * as Eve from "eve";
import type * as EveConnections from "eve/connections";
import type { SessionAuthContext } from "eve/context";
import type { MemoryScopeContext } from "eve/memory";
import type * as EveTools from "eve/tools";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GoogleAccountSummary } from "@db/services/connectors/google";
import {
  dynamicContextFor,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { googleRequestedScopes } from "@shared/connectors/google/scopes";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { sitePrincipal } from "@agent/lib/site-principal";

// With TEEMIQ's tools configured, only the session decides whether a chat
// gets them. The environment module validates once on import.
vi.hoisted(() => {
  vi.stubEnv("TEEMIQ_FINANCE_MCP_URL", "https://team.example/api/mcp/finance");
});

// Google, set up and connected only where a case says so.
const google = vi.hoisted(() => ({
  account: vi.fn<() => Promise<GoogleAccountSummary | undefined>>(),
  configured: false,
}));
vi.mock(import("@shared/connectors/google/oauth"), async (importOriginal) => ({
  ...(await importOriginal()),
  googleOAuthClient: () =>
    google.configured
      ? {
          clientId: "client.apps.googleusercontent.com",
          clientSecret: "secret",
        }
      : undefined,
}));
vi.mock(import("@db/services/connectors/google"), async (importOriginal) => ({
  ...(await importOriginal()),
  googleAccountOf: google.account,
}));

vi.mock("eve", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof Eve>())
);
vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);
vi.mock("eve/connections", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveConnections>())
);

import teemiq from "@agent/connections/teemiq";
import calendar from "@agent/tools/calendar";
import drive from "@agent/tools/drive";
import gmail from "@agent/tools/gmail";
import personalInfoMemory from "@agent/memory/personal_info";
import workstreamMemory from "@agent/memory/workstreams";
import bigquery from "@agent/tools/bigquery";
import messaging from "@agent/tools/messaging";
import schedules from "@agent/tools/schedules";
import siteTask from "@agent/tools/site_task";
import vault from "@agent/tools/vault";

const member = accessScopeForUser("better-auth:user-1");

// BigQuery stays off here: ASSIST_BIGQUERY_KEY is unset, so it adds nothing
// to any mode (tests/agent/tools/bigquery.test.ts covers it with a key).
// Google is set up only in the one case that pins which modes it reaches;
// tests/agent/google covers its tools in full.
const groupedTools = [
  bigquery,
  calendar,
  drive,
  gmail,
  messaging,
  schedules,
  siteTask,
  vault,
];
// The tool files whose tools depend on the session's mode, which
// groupedTools evaluates; every other root tool file is static.
const dynamicToolFiles = new Set([
  "bigquery.ts",
  "calendar.ts",
  "drive.ts",
  "gmail.ts",
  "messaging.ts",
  "schedules.ts",
  "site_task.ts",
  "vault.ts",
]);

describe("authored mode capability matrix", () => {
  it("gives interactive turns the authored coordinator capabilities", async () => {
    expect(await authoredCapabilities("linq-message")).toEqual([
      "personal_info__update",
      "react_to_message",
      "request_vault_import",
      "request_vault_setup",
      "schedules-answer",
      "schedules-create",
      "schedules-list",
      "schedules-update",
      "send_message",
      "workstreams__find",
      "workstreams__forget",
      "workstreams__read",
      "workstreams__save",
    ]);
  });

  it("gives scheduled workers no authored grouped or memory capabilities", async () => {
    expect(await authoredCapabilities("scheduled-worker")).toEqual([]);
  });

  it("limits authored scheduled reporting tools to delivery or resuming its own run", async () => {
    expect(await authoredCapabilities("scheduled-result")).toEqual([
      "request_vault_setup",
      "schedules-answer",
      "send_message",
    ]);
  });

  it("gives site tasks no memory tools, so a page cannot rewrite the owner's details or notes, and the end tool only them", async () => {
    expect(await authoredCapabilities("assist-site", "teemiq")).toEqual([
      "end_site_task",
      "react_to_message",
      "request_vault_import",
      "request_vault_setup",
      "schedules-answer",
      "schedules-create",
      "schedules-list",
      "schedules-update",
      "send_message",
    ]);
  });
});

describe("site chat capabilities", () => {
  it("gives a site chat only its reply among the authored tools: no vault, schedules, memory or end tool", async () => {
    const chat = sitePrincipal(
      {
        chat: "00000000-0000-4000-8000-0000000000c1",
        op: "chat.create",
        site: "teemiq",
        siteUser: "teemiq-user-1",
      },
      "owner@example.test",
      member
    );

    expect(
      await capabilitiesOf(
        dynamicContextFor({
          auth: { current: chat, initiator: chat },
          channel: { kind: "http", metadata: {} },
          sessionId: "session-chat",
        })
      )
    ).toEqual(["send_message"]);
  });
});

describe("WhatsApp capabilities", () => {
  const whatsapp = {
    attributes: {
      conversationChannel: "whatsapp",
      email: "member@example.test",
      workspaceId: member.workspaceId,
    },
    authenticator: "assist-whatsapp",
    principalId: member.userId,
    principalType: "user",
  };

  it("gives a WhatsApp chat its reply alone among the authored tools: no vault, schedules, memory, site or Accounting tools", async () => {
    // A turn a signed-in member sends into the chat keeps the chat's mode.
    for (const current of [
      whatsapp,
      dynamicContext("authjs").session.auth.current,
    ]) {
      const context = dynamicContextFor({
        auth: { current, initiator: whatsapp },
        channel: { kind: "channel:whatsapp", metadata: {} },
        sessionId: "session-whatsapp",
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each turn is checked on its own.
      expect(await capabilitiesOf(context)).toEqual(["send_message"]);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each turn is checked on its own.
      expect(await evaluateDynamic(teemiq, context)).toBeNull();
    }
  });

  it("leaves a WhatsApp chat exactly send_message, ask_question and web_search", async () => {
    const context = dynamicContextFor({
      auth: { current: whatsapp, initiator: whatsapp },
      channel: { kind: "channel:whatsapp", metadata: {} },
      sessionId: "session-whatsapp",
    });
    // run_browser is a workflow tool, which cannot be dynamic: it stays
    // listed and refuses every call in this mode (tests/agent/tools).
    const staticTools = readdirSync("agent/tools")
      .filter((file) => !dynamicToolFiles.has(file))
      .map((file) => file.replace(/\.ts$/u, ""))
      .filter((tool) => tool !== "run_browser");

    expect(
      [...(await capabilitiesOf(context)), ...staticTools].toSorted()
    ).toEqual(["ask_question", "send_message", "web_search"]);
  });
});

describe("WhatsApp full-access capabilities", () => {
  const full = {
    attributes: {
      conversationChannel: "whatsapp",
      email: "member@example.test",
      whatsappAccess: "full",
      whatsappNumber: "+15550000001",
      workspaceId: member.workspaceId,
    },
    authenticator: "assist-whatsapp",
    principalId: member.userId,
    principalType: "user",
  };

  it("gives a full chat the reply, vault links, Personal Info and saved notes, and none of interactive's reactions or schedules", async () => {
    // A turn the member sends into the chat on the web keeps the chat's mode.
    for (const current of [
      full,
      dynamicContext("authjs").session.auth.current,
    ]) {
      const context = dynamicContextFor({
        auth: { current, initiator: full },
        channel: { kind: "channel:whatsapp", metadata: {} },
        sessionId: "session-whatsapp-full",
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each turn is checked on its own.
      expect(await capabilitiesOf(context)).toEqual([
        "personal_info__update",
        "request_vault_import",
        "request_vault_setup",
        "send_message",
        "workstreams__find",
        "workstreams__forget",
        "workstreams__read",
        "workstreams__save",
      ]);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each turn is checked on its own.
      expect(await evaluateDynamic(teemiq, context)).toBeNull();
    }
  });

  it("adds a connected member's Google tools to a full chat, and none to the narrow chat", async () => {
    google.configured = true;
    google.account.mockResolvedValue({
      connectedAt: "2026-11-25T08:00:00.000Z",
      email: "member@example.test",
      needsReconnect: false,
      scopes: [...googleRequestedScopes],
    });
    onTestFinished(() => {
      google.configured = false;
      google.account.mockReset();
    });
    const narrow = {
      ...full,
      attributes: {
        conversationChannel: "whatsapp",
        email: "member@example.test",
        workspaceId: member.workspaceId,
      },
    };
    expect(await capabilitiesOf(whatsappChat(full))).toEqual([
      "calendar_create_event",
      "calendar_free_busy",
      "calendar_list_events",
      "drive_read_file",
      "drive_search",
      "gmail_create_draft",
      "gmail_read_thread",
      "gmail_search",
      "gmail_send",
      "personal_info__update",
      "request_vault_import",
      "request_vault_setup",
      "send_message",
      "workstreams__find",
      "workstreams__forget",
      "workstreams__read",
      "workstreams__save",
    ]);
    expect(await capabilitiesOf(whatsappChat(narrow))).toEqual([
      "send_message",
    ]);
  });

  it("recalls Personal Info and saved notes in a full chat and its browser worker, and never in a narrow one", () => {
    const narrow = {
      ...full,
      attributes: {
        conversationChannel: "whatsapp",
        email: "member@example.test",
        workspaceId: member.workspaceId,
      },
    };
    expect(personalInfoMemory.scope(memoryScopeContext(full))).toBe(
      member.workspaceId
    );
    expect(workstreamMemory.scope(memoryScopeContext(full))).toBe(
      member.workspaceId
    );
    expect(personalInfoMemory.scope(memoryScopeContext(narrow))).toBeNull();
    expect(workstreamMemory.scope(memoryScopeContext(narrow))).toBeNull();
  });
});

function whatsappChat(principal: SessionAuthContext) {
  return dynamicContextFor({
    auth: { current: principal, initiator: principal },
    channel: { kind: "channel:whatsapp", metadata: {} },
    sessionId: "session-whatsapp-full",
  });
}

function memoryScopeContext(initiator: SessionAuthContext): MemoryScopeContext {
  return {
    abortSignal: new AbortController().signal,
    channel: { kind: "channel:whatsapp", metadata: {} },
    session: {
      auth: { current: initiator, initiator },
      id: "session-whatsapp-full",
    },
  };
}

async function authoredCapabilities(authenticator: string, site?: string) {
  return capabilitiesOf(dynamicContext(authenticator, site));
}

async function capabilitiesOf(context: ReturnType<typeof dynamicContextFor>) {
  const capabilities: string[] = [];

  const resolvedGroups = await Promise.all(
    groupedTools.map(async (definition) => {
      const resolved = await evaluateDynamic(definition, context);
      return resolved && !("execute" in resolved) ? Object.keys(resolved) : [];
    })
  );
  capabilities.push(...resolvedGroups.flat());

  const personalInfoTools = await personalInfoMemory.provider.tools({
    abortSignal: new AbortController().signal,
    channel: context.channel,
    session: context.session,
    memory: {
      scope: {
        key: "personal-info-key",
        namespace: "openinstinct-personal-info-v1",
        value: member.workspaceId,
      },
      slot: "personal_info",
    },
  });
  if (personalInfoTools) {
    capabilities.push(
      ...Object.keys(personalInfoTools).map((name) => `personal_info__${name}`)
    );
  }

  const workstreamTools = await workstreamMemory.provider.tools({
    abortSignal: new AbortController().signal,
    channel: context.channel,
    session: context.session,
    memory: {
      scope: {
        key: "workstreams-key",
        namespace: "workstreams",
        value: member.workspaceId,
      },
      slot: "workstreams",
    },
  });
  if (workstreamTools)
    capabilities.push(
      ...Object.keys(workstreamTools).map((name) => `workstreams__${name}`)
    );

  return capabilities.toSorted();
}

// A site's principal starts its session, so it is the initiator as well.
function dynamicContext(authenticator: string, site?: string) {
  const attributes: Readonly<Record<string, string>> = site
    ? { site, workspaceId: member.workspaceId }
    : { workspaceId: member.workspaceId };
  const principal = {
    attributes,
    authenticator,
    principalId: member.userId,
    principalType: "user",
  };
  return dynamicContextFor({
    auth: { current: principal, initiator: site ? principal : null },
    channel: { kind: "channel:linq", metadata: {} },
    sessionId: "session-1",
  });
}
