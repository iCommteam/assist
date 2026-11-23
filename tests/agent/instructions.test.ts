import type * as EveInstructions from "eve/instructions";
import { describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";

vi.mock("eve/instructions", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveInstructions>())
);

import executionSafety from "@agent/instructions/10-execution-safety";
import roleInstructions from "@agent/instructions/20-role";
import siteTask from "@agent/instructions/22-site-task";
import workerCoordination from "@agent/instructions/25-worker-coordination";
import messageStyle from "@agent/instructions/30-message-style";
import workerSiteLogin from "@agent/subagents/browser-agent/instructions/site-login";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";

describe("agent instructions", () => {
  it.each([
    ["scheduled-worker", "isolated background session"],
    ["scheduled-result", "evaluating the completed outcome"],
    ["linq", "root coordinator"],
  ])("selects %s instructions for the current turn", async (role, phrase) => {
    const selected = await evaluateDynamic(
      roleInstructions,
      dynamicContext(role)
    );
    expect(selected?.content).toContain(phrase);
  });

  it.each(["interactive", "scheduled-worker", "scheduled-result"])(
    "names the agent iCommAssist in %s turns",
    async (role) => {
      const selected = await evaluateDynamic(
        roleInstructions,
        dynamicContext(role)
      );
      expect(selected?.content).toContain("You are iCommAssist");
      expect(selected?.content).not.toContain("OpenInstinct");
    }
  );

  it("limits scheduled-result turns to reporting", async () => {
    const selected = await evaluateDynamic(
      roleInstructions,
      dynamicContext("scheduled-result")
    );
    expect(selected?.content).toContain(
      "Never invoke another agent, alter a schedule or profile, read or change vault contents, access an account"
    );
    expect(selected?.content).toContain(
      "call `request_vault_setup` with only the safe metadata"
    );
    expect(selected?.content).toContain(
      "After `send_message`, emit only `DELIVERY_COMPLETE`"
    );
  });

  it("omits execution safety from scheduled reports", async () => {
    expect(
      await evaluateDynamic(executionSafety, dynamicContext("scheduled-result"))
    ).toBeNull();
    const selected = await evaluateDynamic(
      executionSafety,
      dynamicContext("scheduled-worker")
    );
    expect(selected?.content).toContain("approval");
  });

  it("avoids tool approval loops and offers no Link purchases", async () => {
    const selected = await evaluateDynamic(
      executionSafety,
      dynamicContext("linq-message")
    );
    expect(selected?.content).toContain(
      "Tools run without a separate Eve approval step"
    );
    expect(selected?.content).not.toContain("Link");
    expect(selected?.content).not.toContain("native approval card");
  });

  it("treats personal information as recalled context instead of a read tool", async () => {
    const selected = await evaluateDynamic(
      roleInstructions,
      dynamicContext("linq-message")
    );
    expect(selected?.content).toContain(
      "never call `personal_info__update` to read it"
    );
    expect(selected?.content).toContain(
      "say plainly when a requested value is not present"
    );
    expect(selected?.content).toContain(
      "never import third-party claims or task details into those slots"
    );
  });

  it("omits message style from scheduled workers", async () => {
    expect(
      await evaluateDynamic(messageStyle, dynamicContext("scheduled-worker"))
    ).toBeNull();
    const selected = await evaluateDynamic(
      messageStyle,
      dynamicContext("scheduled-result")
    );
    expect(selected?.content).toContain("natural text message");
  });

  it("shares the exact browser contract with scheduled workers", async () => {
    const selections = await Promise.all(
      ["linq", "scheduled-worker"].map((authenticator) =>
        evaluateDynamic(workerCoordination, dynamicContext(authenticator))
      )
    );
    for (const selected of selections) {
      expect(selected?.content).toContain(
        "tool supplies the required structured completion schema"
      );
      expect(selected?.content).toContain(
        "using the completion tool Eve supplies"
      );
      expect(selected?.content).toContain(
        "do not retry the task, start another worker for the same site, or try another route to it"
      );
      expect(selected?.content).toContain(
        "Never assign an Amazon site: they are blocked by policy for now."
      );
    }

    expect(
      await evaluateDynamic(
        workerCoordination,
        dynamicContext("scheduled-result")
      )
    ).toBeNull();
  });

  it("tells the coordinator the worker returns no images and no Link checkout", async () => {
    const selected = await evaluateDynamic(
      workerCoordination,
      dynamicContext("linq")
    );
    expect(selected?.content).toContain("The worker returns text only.");
    expect(selected?.content).not.toContain("/artifacts/");
    expect(selected?.content).not.toContain("fill_from_link");
    expect(selected?.content).not.toContain("link__create_spend_request");
    expect(selected?.content).not.toContain("merchant_url");
    expect(selected?.content).toContain(
      "unless the worker's latest result says it kept the browser open"
    );
  });

  it("keeps resumed scheduled turns in worker mode", async () => {
    const selected = await evaluateDynamic(
      roleInstructions,
      dynamicContext("linq-message", "scheduled-worker")
    );
    expect(selected?.content).toContain("isolated background session");
  });
});

describe("site task instructions", () => {
  it("tells the coordinator a site task has no one watching and ends in one reply", async () => {
    const selected = await evaluateDynamic(siteTask, siteContext());
    expect(selected?.content).toContain("connected site `teemiq`");
    expect(selected?.content).toContain("No one is watching while you work");
    expect(selected?.content).toContain("Do not ask questions you can avoid");
    expect(selected?.content).toContain("Never call `ask_question`");
    expect(selected?.content).toContain("Do not use `react_to_message`");
    expect(selected?.content).toContain(
      "Finish with exactly one `send_message` call"
    );
    expect(selected?.content).toContain(
      "must delete its browser before it returns"
    );
    expect(selected?.content).toContain(
      "Personal Info and workstreams are off for a site task"
    );
    expect(selected?.content).toContain(
      "A site task can use at most one saved login: the one the site pinned it to."
    );
    expect(selected?.content).toContain(
      "A site task may pause only for a one-time code that the pinned login's website sent by email or text message: the browser worker asks the site for it with `fill_code_from_site`"
    );
    expect(selected?.content).toContain("Never ask for a code yourself");
    expect(selected?.content).toContain(
      "never cancel a worker while it waits for one"
    );
    expect(selected?.content).toContain(
      "such as a sign-in with no saved login, a CAPTCHA or bot check, a passkey, a device or push approval, a browser handoff, or a purchase decision, ends the task"
    );
    expect(selected?.content).not.toContain("Pinned login");
  });

  it("tells the coordinator of a pinned task its one account, site and limits", async () => {
    const selected = await evaluateDynamic(siteTask, pinnedSiteContext());
    expect(selected?.content).toContain("connected site `teemiq`");
    expect(selected?.content).toContain(
      "The site pinned this task to one saved login, for https://login.vendor.example."
    );
    expect(selected?.content).toContain(
      "tell it in its assignment that the task is limited to that one account"
    );
    expect(selected?.content).toContain(
      "tell the worker to fill it with `fill_totp_from_vault`"
    );
    expect(selected?.content).toContain(
      "tell the worker to focus the code field and call `fill_code_from_site`, which asks the site for the code and fills it; it is the only question this task may ask."
    );
    expect(selected?.content).not.toContain("still ends the task");
    expect(selected?.content).toContain(
      "never change account settings, passwords, email addresses, phone numbers, addresses, or payout or payment details"
    );
    expect(selected?.content).toContain(
      "never submit any form other than the sign-in and the search, filter, or download"
    );
    expect(selected?.content).not.toContain("{{origin}}");
  });

  it("gives the browser worker of a pinned task its limits, and no one else", async () => {
    const pinned = await evaluateDynamic(workerSiteLogin, pinnedSiteContext());
    expect(pinned?.content).toContain(
      "pinned to one saved login, for https://login.vendor.example"
    );
    expect(pinned?.content).toContain("Work only in that account.");
    expect(pinned?.content).toContain(
      "never submit any form other than the sign-in and the search, filter, or download"
    );
    expect(pinned?.content).toContain("Stop and return `failure`");
    expect(pinned?.content).toContain(
      "keep the saved sign-in of that login alone, so the site may start signed out"
    );
    expect(pinned?.content).toContain(
      "When the sign-in asks for an authenticator-app code, fill it with `fill_totp_from_vault`"
    );
    expect(pinned?.content).toContain(
      "When it sends a code by email or text message, keep the browser on the code page, focus the code field, and call `fill_code_from_site` with `sentBy`"
    );
    expect(pinned?.content).toContain(
      "a CAPTCHA, passkey, device or push approval, or any other step for a person ends the task"
    );

    expect(await evaluateDynamic(workerSiteLogin, siteContext())).toBeNull();
    expect(
      await evaluateDynamic(workerSiteLogin, dynamicContext("authjs", "authjs"))
    ).toBeNull();
  });

  it("keeps site sessions in interactive mode", async () => {
    const selected = await evaluateDynamic(roleInstructions, siteContext());
    expect(selected?.content).toContain("root coordinator");
  });

  it.each([
    ["a member session", dynamicContext("authjs", "authjs")],
    ["a session with no initiator", dynamicContext("authjs")],
    [
      "a scheduled worker",
      dynamicContext("scheduled-worker", "scheduled-worker"),
    ],
  ])("adds nothing to %s", async (_case, context) => {
    expect(await evaluateDynamic(siteTask, context)).toBeNull();
  });
});

// A later turn from the owner keeps the pin of the task's initiator.
function pinnedSiteContext() {
  const owner = accessScopeForUser("better-auth:owner-1");
  const initiator = sitePrincipal(
    {
      login: { id: "login-1", origin: "https://login.vendor.example" },
      op: "create",
      site: "teemiq",
    },
    "owner@example.test",
    owner
  );
  return dynamicContextFor({
    auth: {
      current: {
        attributes: { workspaceId: owner.workspaceId },
        authenticator: "authjs",
        principalId: owner.userId,
        principalType: "user",
      },
      initiator,
    },
    channel: { kind: "http", metadata: {} },
    sessionId: "session-site",
  });
}

function siteContext() {
  const site = {
    attributes: { site: "teemiq", workspaceId: "personal:owner" },
    authenticator: "assist-site",
    principalId: "better-auth:owner-1",
    principalType: "user",
  };
  return dynamicContextFor({
    auth: { current: site, initiator: site },
    channel: { kind: "http", metadata: {} },
    sessionId: "session-site",
  });
}

function dynamicContext(
  authenticator: string,
  initiatorAuthenticator?: string
) {
  return dynamicContextFor({
    auth: {
      current: {
        attributes: {},
        authenticator,
        principalId: "user-1",
        principalType: "user",
      },
      initiator:
        initiatorAuthenticator === undefined
          ? null
          : {
              attributes: {},
              authenticator: initiatorAuthenticator,
              principalId: "user-1",
              principalType: "user",
            },
    },
    channel: { kind: "channel:linq", metadata: {} },
    sessionId: "session-1",
  });
}
