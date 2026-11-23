import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import { readVaultItem } from "@db/services/vault";
import { siteLoginOfSession, siteOfSession } from "@agent/lib/site-principal";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import {
  assertWorkerNotBlocked,
  inspectBrowserPages,
} from "@agent/subagents/browser-agent/lib/policy/page-check";
import {
  recordFilledDocuments,
  rememberInjectedValues,
} from "@agent/subagents/browser-agent/lib/autofill/redaction";
import {
  currentKernelPageOrigin,
  fillWithKernelNativeAutofill,
  nativeAutofillTokens,
} from "../lib/autofill/native";
import { vaultAutofillProvider } from "../lib/autofill/provider";
import { materializeAutofillClaims } from "../lib/autofill/service";

const inputSchema = z.object({
  browserSessionId: z.string().trim().min(1).max(500),
  candidateId: z.string().trim().min(1).max(500),
});

const outputSchema = z.object({
  filledClaims: z.number().int().nonnegative(),
  kind: z.literal("login"),
  origin: z.string(),
  success: z.literal(true),
});

// Fixed messages from the vault and login injector. Any other failure may
// echo browser state, so it is replaced with a generic message.
const safeFillMessages = new Set([
  "Focus a visible username, email, phone, or current-password field and retry.",
  "No active browser tab was found.",
  "The active tab no longer matches the approved origin.",
  "The focused login form does not accept a field available in this saved login.",
  "The login form rejected secure credential autofill or is not served from the saved origin.",
  "The selected vault item has no secret.",
  "The selected vault item has no values for this form.",
  "The selected vault item is not compatible with this form.",
  "The selected vault item was not found.",
  "This saved login is not assigned to a website. Re-save it before autofill.",
]);
const restrictedOriginMessage =
  /^This saved login is restricted to https?:\/\/[^\s]+\.$/u;

export default defineTool({
  description:
    "Fill a saved login into the sign-in form with an opaque handle returned by list_vault. Focus the username, email, phone, or password control in the intended form first. Only saved logins can be filled. Never supply vault fields, selectors, origins, or secret values.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);

    await requireOwnedBrowserSession(
      scope,
      context.session,
      input.browserSessionId
    );
    assertWorkerNotBlocked();
    // A site task fills only the login it is pinned to, and none without a
    // pin. Any other handle reads as missing, whether or not it exists.
    const { initiator } = context.session.auth;
    if (
      siteOfSession(initiator) &&
      siteLoginOfSession(initiator)?.id !== input.candidateId
    ) {
      throw new Error("The selected vault item was not found.");
    }
    const item = await readVaultItem(scope, input.candidateId);
    if (!item) throw new Error("The selected vault item was not found.");
    if (item.kind !== "login") {
      throw new Error(
        "Only saved logins can be filled for now. Ask the coordinator for this form's values instead."
      );
    }
    const browser = await kernel.browsers.retrieve(
      input.browserSessionId,
      {},
      { signal: context.abortSignal }
    );
    if (!browser.profile_save_changes) {
      throw new Error(
        "Login autofill requires a browser created with save_changes: true. Delete this browser, create a writable browser at the same URL, then focus and fill again."
      );
    }

    try {
      const origin = await currentKernelPageOrigin({
        browserSessionId: input.browserSessionId,
        signal: context.abortSignal,
      });
      const tokens = nativeAutofillTokens.login;
      const claims = await materializeAutofillClaims(
        scope,
        input.candidateId,
        {
          availableTokens: new Set(tokens),
          origin,
          surface: {
            fields: tokens.map((token) => ({ score: 100, token })),
            id: "credentials",
            kind: "credentials",
          },
        },
        vaultAutofillProvider
      );
      // Registered before the fill: a fill that fails halfway may still have
      // written values.
      rememberInjectedValues(
        context.session.id,
        input.browserSessionId,
        claims.map(({ value }) => value)
      );
      const result = await fillWithKernelNativeAutofill({
        browserSessionId: input.browserSessionId,
        claims,
        expectedOrigin: origin,
        kind: "login",
        signal: context.abortSignal,
      });
      try {
        recordFilledDocuments(
          input.browserSessionId,
          await inspectBrowserPages(input.browserSessionId, context.abortSignal)
        );
      } catch {
        // Without the open documents, values stay stripped until the browser
        // is deleted.
      }

      return {
        filledClaims: result.filledClaims,
        kind: "login" as const,
        origin: result.origin,
        success: true as const,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // oxlint-disable-next-line eslint/preserve-caught-error -- The cause may echo browser state, so it is withheld.
      throw new Error(
        safeFillMessages.has(message) || restrictedOriginMessage.test(message)
          ? message
          : "The saved login could not be filled. Focus the username or password control in the sign-in form and retry once without reading field values; if it fails again, report the failure."
      );
    }
  },
});
