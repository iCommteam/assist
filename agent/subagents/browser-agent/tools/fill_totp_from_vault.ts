import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import { readVaultItem } from "@db/services/vault";
import { siteLoginOfSession, siteOfSession } from "@agent/lib/site-principal";
import {
  assertWorkerNotBlocked,
  inspectBrowserPages,
} from "@agent/subagents/browser-agent/lib/policy/page-check";
import {
  recordFilledDocuments,
  rememberInjectedCode,
} from "@agent/subagents/browser-agent/lib/autofill/redaction";
import {
  currentKernelPageOrigin,
  fillKernelOneTimeCode,
} from "../lib/autofill/native";
import { authenticatorCodeForLogin } from "../lib/autofill/provider";

const inputSchema = z.object({
  browserSessionId: z.string().trim().min(1).max(500),
  candidateId: z.string().trim().min(1).max(500),
});

const filledMessage =
  "The current authenticator code was filled. Submit the code form now, before the code changes.";

const outputSchema = z.object({
  message: z.literal(filledMessage),
  success: z.literal(true),
});

// Fixed messages from the vault and the code injector. Any other failure may
// echo the code or browser state, so it is replaced with a generic message.
const safeFillMessages = new Set([
  "Focus the visible authenticator code field of the sign-in and retry.",
  "No active browser tab was found.",
  "The active tab no longer matches the approved origin.",
  "The code field did not keep the code that was filled.",
  "The code field has a different number of boxes than the code has characters.",
  "The selected vault item has no secret.",
  "The selected vault item was not found.",
  "This saved login has no authenticator setup key.",
  "This saved login is not assigned to a website. Re-save it before autofill.",
]);
const restrictedOriginMessage =
  /^This saved login is restricted to https?:\/\/[^\s]+\.$/u;

export default defineTool({
  description:
    "Fill the current authenticator-app code of a saved login into the sign-in's code field, using the same opaque handle from list_vault as fill_from_vault. Focus the visible one-time code field first. The server computes the code and never shows it. Only a saved login with an authenticator setup key has codes; a code sent by email or text message cannot be filled.",
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
    // The same pin as fill_from_vault: any other handle reads as missing.
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
        "Only a saved login can hold an authenticator setup key."
      );
    }

    try {
      const origin = await currentKernelPageOrigin({
        browserSessionId: input.browserSessionId,
        signal: context.abortSignal,
      });
      const code = await authenticatorCodeForLogin(
        scope,
        input.candidateId,
        origin,
        Date.now()
      );
      // Registered before the fill: a fill that fails halfway may still have
      // written the code.
      rememberInjectedCode(context.session.id, input.browserSessionId, code);
      await fillKernelOneTimeCode({
        browserSessionId: input.browserSessionId,
        code,
        expectedOrigin: origin,
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
      return { message: filledMessage, success: true as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // oxlint-disable-next-line eslint/preserve-caught-error -- The cause may echo the code or browser state, so it is withheld.
      throw new Error(
        safeFillMessages.has(message) || restrictedOriginMessage.test(message)
          ? message
          : "The authenticator code could not be filled. Focus the code field of the sign-in and retry once without reading its value; if it fails again, report the failure."
      );
    }
  },
});
