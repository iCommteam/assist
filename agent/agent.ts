import { defineAgent, defineDynamic } from "eve";
import { scheduledRunIdentity } from "@agent/lib/schedules/identity";
import { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import { coordinatorModel } from "@agent/lib/models";
import { sessionUsageExceeded } from "@agent/lib/usage-limit";

export default defineAgent({
  build: {
    // The browser-agent subagent's Browser Loop tools load this at runtime.
    externalDependencies: ["@onkernel/browser-loop"],
  },
  defaultTools: false,
  // eve resolves this before every model call, so the lease is rechecked per step.
  model: defineDynamic(async (ctx) => {
    const scheduledRun = scheduledRunIdentity(ctx.session.auth);
    if (
      scheduledRun &&
      !(await isScheduledAgentRunLeaseActive(
        scheduledRun.runId,
        scheduledRun.leaseToken
      ))
    ) {
      throw new Error("The scheduled run lease is no longer active.");
    }
    const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
    if (!caller) throw new Error("An authenticated user is required.");
    return coordinatorModel();
  }),
  reasoning: "low",
  compaction: {
    threshold: 0.7,
  },
  // The browser-agent subagent authors no limit of its own, so it uses this one.
  limits: {
    sessionUsage: sessionUsageExceeded,
  },
  // Keep run data for the World's default period. Without this, the trace policy
  // in agent/instrumentation/otel.ts (no inputs or outputs) derives zero
  // retention and finished transcripts become unreadable.
  experimental: {
    workflow: {
      retention: "default",
    },
  },
});
