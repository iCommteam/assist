import { call } from "eve/events";
import { defineHook } from "eve/hooks";
import { z } from "zod";
import { rememberInjectedValues } from "@agent/subagents/browser-agent/lib/autofill/redaction";

const filledCodeSchema = z.object({
  input: z.object({ browserSessionId: z.string().min(1) }),
  name: z.literal("fill_code_from_site"),
  output: z.object({ filled: z.literal(true) }),
});

// fill_code_from_site fills in a workflow step, which cannot write the
// worker's eve state. The mark that keeps rendered values stripped while the
// filled page stays open, even after a restart forgets the code itself, is
// set here once the call has settled.
export default defineHook({
  events: {
    "call.settled"(event, ctx) {
      const filled = filledCodeSchema.safeParse(
        call(ctx.view, event.data.callId)
      );
      if (!filled.success) return;
      rememberInjectedValues(
        ctx.session.id,
        filled.data.input.browserSessionId,
        []
      );
    },
  },
});
