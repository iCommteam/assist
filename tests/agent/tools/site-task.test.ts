import type * as EveTools from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  dynamicContextFor,
  dynamicTool,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { toolContextFor } from "@tests/helpers/tool-context";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";

vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);

import siteTask from "@agent/tools/site_task";

const owner = accessScopeForUser("better-auth:owner-1");
const site = sitePrincipal(
  { op: "create", site: "teemiq" },
  "owner@example.test",
  owner
);
const siteChat = sitePrincipal(
  {
    chat: "00000000-0000-4000-8000-0000000000c1",
    op: "chat.create",
    site: "teemiq",
    siteUser: "teemiq-user-1",
  },
  "owner@example.test",
  owner
);
const member = {
  attributes: { workspaceId: owner.workspaceId },
  authenticator: "authjs",
  principalId: owner.userId,
  principalType: "user",
};

describe("site task end tool", () => {
  it("ends a site task's turn with one of the fixed results, only in the root session", async () => {
    const tools = await evaluateDynamic(
      siteTask,
      dynamicContextFor({ auth: { current: site, initiator: site } })
    );
    const end = dynamicTool(tools, "end_site_task");

    expect(end.endsTurn).toBe(true);
    expect(end.availableInSubagents).toBe(false);
    expect(
      await end.execute({ result: "login_failed" }, toolContextFor())
    ).toEqual({ result: "login_failed" });
    const input = end.inputSchema;
    if (!(input instanceof z.ZodObject)) throw new Error("Expected Zod input.");
    expect(
      [
        "done",
        "nothing_found",
        "login_failed",
        "sign_in_elsewhere",
        "code_failed",
        "blocked",
        "off_site",
        "failed",
      ].map((result) => input.safeParse({ result }).success)
    ).toEqual(Array.from({ length: 8 }, () => true));
    expect(input.safeParse({ result: "succeeded" }).success).toBe(false);
    expect(end.description).toContain(
      "sign_in_elsewhere: the website asks for the password on a different page of the same site than the saved one."
    );
    expect(input.safeParse({}).success).toBe(false);
  });

  it("stays in a site task when the owner writes a later turn", async () => {
    const tools = await evaluateDynamic(
      siteTask,
      dynamicContextFor({ auth: { current: member, initiator: site } })
    );

    expect(dynamicTool(tools, "end_site_task")).toBeDefined();
  });

  it.each([
    ["a member's chat", { current: member, initiator: member }],
    ["a session with no initiator", { current: member, initiator: null }],
    [
      "a scheduled worker",
      {
        current: { ...member, authenticator: "scheduled-worker" },
        initiator: { ...member, authenticator: "scheduled-worker" },
      },
    ],
    ["a site chat", { current: siteChat, initiator: siteChat }],
  ])("is not offered in %s", async (_case, auth) => {
    expect(
      await evaluateDynamic(siteTask, dynamicContextFor({ auth }))
    ).toBeNull();
  });
});
