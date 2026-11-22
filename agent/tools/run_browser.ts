import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { taskCompletionSchema } from "@agent/subagents/browser-agent/lib/completion";

export default defineWorkflowTool({
  description:
    "Execute one bounded browser assignment and return a verified result. Pass taskId to continue an idle worker with its browser state and context. The completion schema is supplied automatically.",
  inputSchema: z.object({
    message: z.string().min(1),
  }),
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
      });
      if (!browserAllowed) {
        ctx.reply(
          taskCompletionSchema.parse({
            images: [],
            message:
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
