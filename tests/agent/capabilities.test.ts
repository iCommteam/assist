import type * as Eve from "eve";
import type * as EveTools from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { sitePrincipal } from "@agent/lib/site-principal";

vi.mock("eve", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof Eve>())
);
vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);

import personalInfoMemory from "@agent/memory/personal_info";
import workstreamMemory from "@agent/memory/workstreams";
import messaging from "@agent/tools/messaging";
import schedules from "@agent/tools/schedules";
import siteTask from "@agent/tools/site_task";
import vault from "@agent/tools/vault";

const member = accessScopeForUser("better-auth:user-1");

const groupedTools = [messaging, schedules, siteTask, vault];

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
