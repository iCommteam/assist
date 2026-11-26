import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { approvalResponse } from "@agent/lib/approval-response";
import { browserApproval, browserPrompt } from "@agent/lib/google/browser-gate";
import { resolveModeValue } from "@agent/lib/mode";
import { taskCompletionSchema } from "@agent/subagents/browser-agent/lib/completion";

const inputSchema = z.object({
  message: z.string().min(1),
});

export default defineWorkflowTool({
  description:
    "Execute one bounded browser assignment and return a verified result. Pass taskId to continue an idle worker with its browser state and context. The completion schema is supplied automatically. In a chat that used the member's Google account, each call waits for the member's approval, which shows the whole assignment, so it then takes at most 4,000 characters, all of them visible.",
  // The approval runs outside the workflow body, which never reaches the
  // Google gate's imports.
  approval: {
    prompt: ({ input }) => browserPrompt(input.message),
    request: (context) =>
      browserApproval(
        context,
        inputSchema.safeParse(context.toolInput).data?.message
      ),
    response: approvalResponse,
  },
  inputSchema,
  // Each task keeps one browser-agent session, so later calls with the same
  // taskId continue that worker instead of starting a fresh one.
  async serve(receive, ctx) {
    "use workflow";
    let worker: ReturnType<typeof ctx.agent> | undefined;
    // A plain JSON Schema stays serializable across workflow steps.
    const outputSchema = z
      .record(z.string(), z.json())
      .parse(z.toJSONSchema(taskCompletionSchema));
    /* oxlint-disable eslint/no-await-in-loop -- A serve task handles its calls one at a time, in order. */
    for (;;) {
      const { input, abortSignal } = await receive();
      // Workflow tools cannot be dynamic, so the browser is gated per call: each
      // call carries its own auth, and a scheduled-report turn may continue a
      // task that an interactive turn started.
      const browserAllowed = resolveModeValue(ctx, {
        interactive: true,
        "scheduled-worker": true,
        "whatsapp-full": true,
      });
      // Every other mode is refused, the site chat among them: it visits a
      // supplier's site only through a look or a fetch its site runs. A
      // narrow WhatsApp chat, a locked member's, has no browser at all.
      if (!browserAllowed) {
        ctx.reply(
          taskCompletionSchema.parse({
            images: [],
            message:
              resolveModeValue(ctx, {
                "site-chat":
                  "Browser work is unavailable in an Accounting chat. Visit a supplier's site only through an Accounting look or fetch.",
                whatsapp:
                  "Browser work is unavailable on WhatsApp. Suggest doing it in assist's own app.",
              }) ??
              "Browser work is unavailable while reporting a scheduled result.",
            status: "failure",
          })
        );
        continue;
      }
      worker ??= ctx.agent("browser-agent");
      try {
        const response = await worker.send(input.message, {
          outputSchema,
          signal: abortSignal,
        });
        const result = await response.result();
        if (result.status === "failed") {
          ctx.reply(
            taskCompletionSchema.parse({
              images: [],
              message: `Browser worker failed: ${result.error.message}`,
              status: "failure",
            })
          );
          continue;
        }
        if (result.status === "cancelled") continue;
        ctx.reply(taskCompletionSchema.parse(result.data));
      } catch (error) {
        // A cancelled stretch returns to receive() so the worker stays available.
        if (!abortSignal.aborted) throw error;
      }
    }
    /* oxlint-enable eslint/no-await-in-loop */
  },
});
