import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { sleep } from "eve/workflow";
import { z } from "zod";
import { siteCodeQuestionTitle } from "@shared/identity/site-code/question";

// The site has this long to relay the code. A site task's browsers idle out
// after 30 minutes (manage_browsers), so the browser outlives the wait.
const codeWaitMs = 20 * 60_000;

const expiredMessage =
  'No code arrived within 20 minutes, so nothing was filled. Delete the browser, then return status "failure" saying the one-time code did not arrive in time.';
const withdrawnMessage =
  'The code request ended before a code arrived, so nothing was filled. Delete the browser, then return status "failure" saying no one-time code was received.';

export default defineWorkflowTool({
  description:
    "In a site task pinned to a saved login, ask the site for the one-time code the sign-in just sent by email or text message, wait up to 20 minutes for it, and fill it into the focused code field. Focus the visible code field first. The code is never shown to you. An authenticator-app code is filled with fill_totp_from_vault instead.",
  inputSchema: z.object({
    browserSessionId: z.string().trim().min(1).max(500),
    sentBy: z.enum(["email", "text"]),
  }),
  async execute({ browserSessionId, sentBy }, ctx) {
    "use workflow";
    const prepared = await prepareQuestion(browserSessionId, sentBy, ctx);
    if (!prepared.ok) return { filled: false, message: prepared.message };
    // Racing the question against a timer withdraws it when the timer wins.
    const answer = await Promise.race([
      ctx.ask({
        allowFreeform: true,
        display: "text",
        prompt: prepared.question,
        title: siteCodeQuestionTitle,
      }),
      sleep(codeWaitMs).then(() => "expired" as const),
    ]);
    if (answer === "expired") return { filled: false, message: expiredMessage };
    if (answer.status !== "answered" || answer.text === undefined) {
      return { filled: false, message: withdrawnMessage };
    }
    return fillCode(browserSessionId, answer.text, ctx);
  },
});

// The workflow body may not reach Node.js modules, so the steps load the code
// that reads the browser, the vault and the sealed answer when they run.
async function prepareQuestion(
  browserSessionId: string,
  sentBy: "email" | "text",
  ctx: WorkflowStepToolContext
) {
  "use step";
  const { prepareSiteCodeQuestion } =
    await import("@agent/subagents/browser-agent/lib/autofill/site-code");
  return prepareSiteCodeQuestion(browserSessionId, sentBy, ctx);
}

async function fillCode(
  browserSessionId: string,
  answer: string,
  ctx: WorkflowStepToolContext
) {
  "use step";
  const { fillRelayedSiteCode } =
    await import("@agent/subagents/browser-agent/lib/autofill/site-code");
  return fillRelayedSiteCode(browserSessionId, answer, ctx);
}
