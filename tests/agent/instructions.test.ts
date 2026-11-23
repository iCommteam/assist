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

  it("tells the coordinator to end every site task through the end tool, with when to use each result", async () => {
    const selected = await evaluateDynamic(siteTask, siteContext());
    expect(selected?.content).toContain(
      "Then always end the task with `end_site_task`, alone in your last step, also when the task failed or stopped early. The site reads that result, not your message"
    );
    for (const result of [
      "- `done`: the work the task asked for is finished.",
      "- `nothing_found`: the work was possible, but what the task asked for does not exist",
      "- `login_failed`: the website refused the saved username or password",
      "- `code_failed`: a one-time code was refused or expired, no code arrived in time, or an authenticator-app code could not be filled.",
      "- `blocked`: the website wants something only a person can do, such as a CAPTCHA or bot check, a device or push approval, a passkey, or a link sent to a new device, or the task needs a sign-in it has no saved login for.",
      "- `off_site`: what the task needs, such as the invoice file, is on a website the browser may not open.",
      "- `failed`: anything else that kept the task from finishing",
    ]) {
      expect(selected?.content).toContain(result);
    }
    expect(selected?.content).toContain(
      "decided by what it actually saved, never by the result or the message"
    );
    expect(selected?.content).toContain(
      "The task has 45 minutes in all, its wait for a code included"
    );
    expect(selected?.content).not.toContain(
      "That message is the whole answer the site receives"
    );
  });

  it("tells the coordinator how an invoice job brings its PDFs back and ends", async () => {
    const selected = await evaluateDynamic(siteTask, siteContext());
    for (const text of [
      "A site gets files back only through the browser worker's `save_file`, which keeps a PDF for the site to download; only a task pinned to a saved login has it.",
      "For an invoice job, a task that asks for the invoices or receipts of a period, assign the worker all of it: sign in, open the account's billing or invoices page, and for every invoice or receipt dated in the requested period save its PDF with `save_file`, preferring the supplier's own Download PDF link and opening Stripe's hosted invoice page when that is where the link goes.",
      "Tell it to never pay, buy, upgrade, cancel, submit or change anything beyond the sign-in and the search, filter, or download that finds the documents.",
      "Then end the task with `done` when the worker saved files, or `nothing_found` when the period has no invoice or receipt.",
      "An invoice job without a pinned login ends with `blocked`.",
      "Name the saved files in your reply, never their download addresses.",
    ]) {
      expect(selected?.content).toContain(text);
    }
  });

  it("tells the coordinator of a pinned task which result its own limits end with", async () => {
    const selected = await evaluateDynamic(siteTask, pinnedSiteContext());
    expect(selected?.content).toContain(
      "including a sign-in or billing page on another domain: when what the task needs is there, end the task with `off_site`."
    );
    expect(selected?.content).toContain(
      "An authenticator-app code the vault cannot fill ends the task with `code_failed`"
    );
    expect(selected?.content).toContain(
      "Say in your reply that a pinned site task cannot do it, and end the task with `failed`."
    );
    expect(selected?.content).toContain(
      "plus Stripe's hosted invoice pages on `invoice.stripe.com`, `pay.stripe.com`, `files.stripe.com` and `billing.stripe.com`."
    );
    expect(selected?.content).toContain(
      "Tell the worker to save every PDF the task asks for with `save_file` and to report each saved file's name, never its address. When the worker reports that `save_file` refused a file as being on a website this task may not open, end the task with `off_site`. When it reports a document whose PDF has no address to save, end the task with `failed`, never `nothing_found`."
    );
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
      "`login.vendor.com` also opens `vendor.com` and `billing.vendor.com`"
    );
    expect(selected?.content).toContain(
      "An authenticator-app code the vault cannot fill ends the task"
    );
    expect(selected?.content).not.toContain("and its subdomains");
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
    expect(pinned?.content).toContain(
      "Call `fill_code_from_site` only for a code the website actually sent by email or text message. An authenticator-app code that `fill_totp_from_vault` cannot fill"
    );
    expect(pinned?.content).toContain(
      "the login's host and every other host under the same registrable domain"
    );
    expect(pinned?.content).toContain(
      "filled only on the exact origin the login was saved with"
    );
    expect(pinned?.content).not.toContain("and its subdomains");
    expect(pinned?.content).toContain(
      "the login's host and every other host under the same registrable domain, plus Stripe's hosted invoice pages on `invoice.stripe.com`, `pay.stripe.com`, `files.stripe.com` and `billing.stripe.com`."
    );
    for (const text of [
      "Bring files back with `save_file`: pass a browser that is signed in and the https address of the PDF itself",
      "For an invoice job, sign in, open the account's billing or invoices page, and for every invoice or receipt dated in the requested period save its PDF with `save_file`.",
      "Prefer the supplier's own Download PDF link; when the link goes to Stripe's hosted invoice page, open that page and save the PDF it links to.",
      "Never pay, buy, upgrade, cancel, submit or change anything beyond the sign-in and the search, filter, or download that finds the documents, even when a page offers it.",
      "Then return `success` naming each saved file and its id, or saying that the period has no invoice or receipt. Never write a file's address in your result.",
      "When `save_file` says the file is on a website this task may not open, do not try another route to it: delete the browser and return `failure` saying so.",
      "When an invoice or receipt of the period has a PDF only behind a button that runs a script or sends a form, with no address to save, never report that the period has none: delete the browser and return `failure` saying the document exists but its PDF has no address to save.",
    ]) {
      expect(pinned?.content).toContain(text);
    }

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
