import { NotFoundError } from "@onkernel/sdk";
import type { WorkflowStepToolContext } from "eve/tools";
import { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { readVaultItem } from "@db/services/vault";
import { siteLoginOfSession } from "@agent/lib/site-principal";
import { openSiteCode } from "@shared/identity/site-code/seal";
import {
  blockReason,
  inspectBrowserPages,
} from "@agent/subagents/browser-agent/lib/policy/page-check";
import { rememberInjectedCode } from "@agent/subagents/browser-agent/lib/autofill/redaction";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  assertKernelOneTimeCodeFocus,
  currentKernelPageOrigin,
  fillKernelOneTimeCode,
} from "./native";
import {
  recordSignInElsewhere,
  signInElsewhereMessage,
} from "./sign-in-elsewhere";

// What fill_code_from_site does outside its workflow body. A workflow body may
// not reach Node.js modules, so the tool loads this module only inside its
// steps. A failed step would be retried, so these return their refusal
// instead of throwing.

const filledMessage =
  "The one-time code from the site was filled. Submit the code form now.";
const unreadableMessage =
  'The answer was not a code the site sent for this task, so nothing was filled. Delete the browser, then return status "failure" saying the code could not be used.';
const browserGoneMessage =
  'The browser closed before the code could be filled. Return status "failure" saying the browser expired while waiting for the one-time code.';
const notPinnedMessage =
  "Only a site task pinned to a saved login can ask the site for a one-time code. Ask the coordinator for the code with `Needs user input:` instead.";
const blockedMessage =
  'BLOCKED: the page shows a CAPTCHA, robot check or access block, so no code was asked for. Delete the browser with manage_browsers, then return status "failure" reporting this blocker.';
const outsideSiteMessage =
  'The code page is not on the exact https origin the pinned login was saved with, so no code was asked for or filled. Delete the browser, then return status "failure" saying the code page is on another origin.';
const focusMessage =
  "Focus the visible code field of the sign-in with browser_act, then call fill_code_from_site again.";
const codePageChangedMessage =
  'The code page no longer shows a code field, so the code that arrived was not filled. If the page still asks for a code, focus its code field and call fill_code_from_site once more; otherwise delete the browser and return status "failure" saying the code page changed while the code was on its way.';
const codeNotTakenMessage =
  'The code field did not take the code, so it was not used. Asking again would fail the same way: delete the browser, then return status "failure" saying the code field did not accept the code.';
const missingLoginMessage = "The selected vault item was not found.";
const unknownFailureMessage =
  'The code could not be handled. Focus the code field and call fill_code_from_site once more; if it fails again, delete the browser and return status "failure".';

// Refusals with fixed text. Anything else may quote the page or the code.
const fixedMessages = new Set([
  blockedMessage,
  "Browser session not found.",
  missingLoginMessage,
  notPinnedMessage,
  outsideSiteMessage,
  signInElsewhereMessage,
]);
const focusRefusals = new Set([
  "Focus the visible authenticator code field of the sign-in and retry.",
  "The active tab no longer matches the approved origin.",
]);
const notTakenRefusals = new Set([
  "The code field did not keep the code that was filled.",
  "The code field has a different number of boxes than the code has characters.",
]);

type SentBy = "email" | "text";

// Checks the task, the browser and the focused field before anyone is asked,
// and words the question the site shows a person.
export async function prepareSiteCodeQuestion(
  browserSessionId: string,
  sentBy: SentBy,
  ctx: WorkflowStepToolContext
) {
  try {
    const { login, scope } = await requireCodeTask(ctx, browserSessionId);
    await requireCodePage(ctx, scope, browserSessionId, login.origin);
    await assertKernelOneTimeCodeFocus({
      browserSessionId,
      expectedOrigin: login.origin,
      signal: ctx.abortSignal,
    });
    const item = await readVaultItem(scope, login.id);
    if (item?.kind !== "login") throw new Error(missingLoginMessage);
    return {
      ok: true as const,
      question: codeQuestion(login.origin, item.label, sentBy),
    };
  } catch (error) {
    return {
      message: refusalOf(error instanceof Error ? error : undefined),
      ok: false as const,
    };
  }
}

// Opens the sealed answer and types it into the focused code field. The code
// exists only inside this step and the worker's redaction set.
export async function fillRelayedSiteCode(
  browserSessionId: string,
  answer: string,
  ctx: WorkflowStepToolContext
) {
  try {
    const { login, scope } = await requireCodeTask(ctx, browserSessionId);
    const rootSessionId = ctx.session.parent?.rootSessionId;
    const { betterAuthSecret } = await getInstallationSecrets();
    const code = rootSessionId
      ? openSiteCode(betterAuthSecret, rootSessionId, answer)
      : undefined;
    if (!code) return { filled: false, message: unreadableMessage };
    // Registered before the fill: a fill that fails halfway may still have
    // written the code.
    rememberInjectedCode(ctx.session.id, browserSessionId, code);
    await requireCodePage(ctx, scope, browserSessionId, login.origin);
    // The page may have moved focus during the wait; the code it sent is
    // still good for its one code field.
    await fillKernelOneTimeCode({
      browserSessionId,
      code,
      expectedOrigin: login.origin,
      refocus: true,
      signal: ctx.abortSignal,
    });
    return { filled: true, message: filledMessage };
  } catch (error) {
    return {
      filled: false,
      message: refusalOf(error instanceof Error ? error : undefined, "fill"),
    };
  }
}

async function requireCodeTask(
  ctx: WorkflowStepToolContext,
  browserSessionId: string
) {
  const scope = await requireWorkerScope(ctx);
  const login = siteLoginOfSession(ctx.session.auth.initiator);
  if (!login) throw new Error(notPinnedMessage);
  await requireOwnedBrowserSession(scope, ctx.session, browserSessionId);
  return { login, scope };
}

// The page check's block state lives in the worker's eve state, which a
// workflow step cannot read, so the open tabs are checked afresh. A relayed
// code goes only to the login's own origin over https, as its password and
// authenticator code do: another host under the same domain may serve pages
// someone else wrote, and the question names the login's host. A code page
// on another page of the login's own site is recorded for the site.
async function requireCodePage(
  ctx: WorkflowStepToolContext,
  scope: AccessScope,
  browserSessionId: string,
  loginOrigin: string
) {
  const pages = await inspectBrowserPages(browserSessionId, ctx.abortSignal);
  if (pages.some((page) => blockReason(page) !== undefined)) {
    throw new Error(blockedMessage);
  }
  const origin = await currentKernelPageOrigin({
    browserSessionId,
    signal: ctx.abortSignal,
  });
  if (origin !== loginOrigin || !origin.startsWith("https://")) {
    throw new Error(
      (await recordSignInElsewhere(ctx.session, scope, origin))
        ? signInElsewhereMessage
        : outsideSiteMessage
    );
  }
}

// Worded here, not by a model, so a page cannot word what the site shows a
// person. The label is the owner's own name for the login.
function codeQuestion(loginOrigin: string, label: string, sentBy: SentBy) {
  const name = label
    .replaceAll(/[\p{Cc}\p{Cf}"]+/gu, " ")
    .trim()
    .slice(0, 80);
  const channel = sentBy === "email" ? "email" : "text message";
  return `Enter the one-time code that ${new URL(loginOrigin).host} just sent by ${channel} for the saved login "${name}".`;
}

// Kernel answers 404 for a browser that idled out or was deleted.
function refusalOf(error: Error | undefined, step: "ask" | "fill" = "ask") {
  if (error instanceof NotFoundError) return browserGoneMessage;
  const message = error?.message ?? "";
  if (fixedMessages.has(message)) return message;
  if (focusRefusals.has(message)) {
    return step === "fill" ? codePageChangedMessage : focusMessage;
  }
  if (notTakenRefusals.has(message)) return codeNotTakenMessage;
  if (message.startsWith("This browser no longer exists")) {
    return browserGoneMessage;
  }
  return unknownFailureMessage;
}
