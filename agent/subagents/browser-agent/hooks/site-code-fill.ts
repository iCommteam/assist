import { call } from "eve/events";
import { defineHook } from "eve/hooks";
import { z } from "zod";
import {
  markCodeFilledBrowser,
  recordFilledDocuments,
} from "@agent/subagents/browser-agent/lib/autofill/redaction";
import { inspectBrowserPages } from "@agent/subagents/browser-agent/lib/policy/page-check";

const filledCodeSchema = z.object({
  input: z.object({ browserSessionId: z.string().min(1) }),
  name: z.literal("fill_code_from_site"),
  output: z.object({ filled: z.literal(true) }),
});

// fill_code_from_site fills in a workflow step, which cannot write the
// worker's eve state. The mark that keeps rendered values stripped and
// screenshots withheld while the filled page stays open, even after a restart
// forgets the code itself, is set here once the call has settled.
export default defineHook({
  events: {
    async "call.settled"(event, ctx) {
      const filled = filledCodeSchema.safeParse(
        call(ctx.view, event.data.callId)
      );
      if (!filled.success) return;
      const { browserSessionId } = filled.data.input;
      markCodeFilledBrowser(browserSessionId);
      // The documents open now hold the code, so the mark ends once they are
      // replaced. Unread, it lasts until the browser is deleted.
      try {
        recordFilledDocuments(
          browserSessionId,
          await inspectBrowserPages(browserSessionId)
        );
      } catch {
        // The mark stays on every document.
      }
    },
  },
});
