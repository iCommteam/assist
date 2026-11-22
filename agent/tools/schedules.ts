import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { siteOfSession } from "@agent/lib/site-principal";
import { scheduledReportIdentity } from "@agent/lib/schedules/identity";
import { postScheduledRunRoute } from "@agent/lib/schedules/request";
import {
  scheduleListSummary,
  scheduleOwner,
  scheduleReplyAnchor,
  scheduleSummary,
} from "@agent/lib/schedules/tools";
import { scheduleTimingSchema } from "@shared/schedules/timing";
import {
  createScheduledAgentJob,
  getScheduledAgentRunInput,
  getScheduledAgentRunInputForReport,
  listScheduledAgentJobs,
  updateScheduledAgentJob,
} from "@db/services/scheduled-agent-jobs";

// A schedule spends model and browser time on every run with no one watching,
// so the member approves each new or changed schedule. Pausing or deleting one
// needs no approval. A connected site cannot answer an approval, so its tasks
// may not create or change schedules at all.
const siteScheduleDenial = {
  reason:
    "A connected-site task cannot create or change schedules, because no one can approve them. Say in your reply that the schedule was not created.",
  type: "denied",
} as const;

function scheduleApproval(
  { session }: Pick<ApprovalContext, "session">,
  needsApproval: boolean
): ApprovalStatus {
  if (siteOfSession(session.auth.initiator)) return siteScheduleDenial;
  return needsApproval ? "user-approval" : "not-applicable";
}

function approvalExcerpt(prompt: string) {
  return prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt;
}

const createScheduleInputSchema = z.object({
  missedRunPolicy: z.enum(["run_latest", "catch_up"]).default("run_latest"),
  prompt: z.string().trim().min(1).max(8_000),
  timing: scheduleTimingSchema,
});

export const createSchedule = defineTool({
  description:
    "Create a one-time, fixed-interval, or timezone-aware calendar job for this conversation. Use calendar timing for human wall-clock recurrence so it remains stable across daylight saving time. Summarize the exact requested work in prompt. The user approves each new schedule before it is created.",
  inputSchema: createScheduleInputSchema,
  approval: {
    prompt: ({ input }) =>
      `Create this scheduled job (${input.timing.kind})? "${approvalExcerpt(input.prompt)}"`,
    request: (context) => scheduleApproval(context, true),
  },
  async execute(input, context) {
    const owner = scheduleOwner(context);
    return scheduleSummary(
      await createScheduledAgentJob(owner.scope, {
        ...owner.conversation,
        missedRunPolicy: input.missedRunPolicy,
        prompt: input.prompt,
        replyAnchorMessageId: scheduleReplyAnchor(context),
        timing: input.timing,
      })
    );
  },
});

export const listSchedules = defineTool({
  description:
    "List the authenticated user's one-time and recurring jobs for this conversation. Use this before changing a schedule when the target is ambiguous.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const owner = scheduleOwner(context);
    return (await listScheduledAgentJobs(owner.scope, owner.conversation)).map(
      scheduleListSummary
    );
  },
});

const updateScheduleInputSchema = z
  .object({
    id: z.uuid(),
    prompt: z.string().trim().min(1).max(8_000).optional(),
    status: z.enum(["active", "paused", "deleted"]).optional(),
    timing: scheduleTimingSchema.optional(),
  })
  .refine(
    ({ prompt, status, timing }) =>
      prompt !== undefined || status !== undefined || timing !== undefined,
    { message: "Provide at least one schedule change." }
  );

export const updateSchedule = defineTool({
  description:
    "Update, pause, resume, or delete one of the authenticated user's scheduled jobs. Set status paused or active to pause or resume it. List schedules first when the target is ambiguous. The user approves a changed prompt or timing and a resume; pausing or deleting runs at once.",
  inputSchema: updateScheduleInputSchema,
  approval: {
    prompt: ({ input }) =>
      input.status === "active" &&
      input.prompt === undefined &&
      input.timing === undefined
        ? "Resume this scheduled job?"
        : `Change this scheduled job${input.prompt === undefined ? "" : ` to "${approvalExcerpt(input.prompt)}"`}?`,
    request: (context) =>
      scheduleApproval(
        context,
        context.toolInput === undefined ||
          context.toolInput.prompt !== undefined ||
          context.toolInput.timing !== undefined ||
          context.toolInput.status === "active"
      ),
  },
  async execute({ id, ...patch }, context) {
    const owner = scheduleOwner(context);
    const job = await updateScheduledAgentJob(
      owner.scope,
      owner.conversation,
      id,
      patch
    );
    if (!job) throw new Error("Schedule not found.");
    return scheduleSummary(job);
  },
});

export const answerSchedule = defineTool({
  description:
    "Resume a scheduled task that is waiting for input. During scheduled reporting, use existing conversation context when it clearly answers the request. During an interactive turn, pass the user's answer exactly as given.",
  inputSchema: z.strictObject({
    answer: z.string().trim().min(1).max(8_000),
    runId: z.uuid(),
  }),
  async execute({ answer, runId }, context) {
    const pending = await pendingScheduledRun(context, runId);
    if (!pending) {
      throw new Error("That scheduled task is not waiting for input.");
    }
    const response = await postScheduledRunRoute(
      "/internal/scheduled-run/respond",
      {
        answer,
        leaseToken: pending.leaseToken,
        runId: pending.runId,
      }
    );
    if (response.status !== 202) {
      throw new Error(
        response.status === 422
          ? "That answer does not match the pending choices."
          : "The scheduled task could not be resumed."
      );
    }
    return { resumed: true, runId };
  },
});

export default defineDynamic((context) =>
  resolveModeValue(context, {
    interactive: {
      "schedules-answer": answerSchedule,
      "schedules-create": createSchedule,
      "schedules-list": listSchedules,
      "schedules-update": updateSchedule,
    },
    "scheduled-report": { "schedules-answer": answerSchedule },
  })
);

async function pendingScheduledRun(context: ToolContext, runId: string) {
  const resolvePending = resolveModeValue(context, {
    interactive: () => {
      const owner = scheduleOwner(context);
      return getScheduledAgentRunInput(owner.scope, owner.conversation, runId);
    },
    "scheduled-report": () => {
      const report = scheduledReportIdentity(context.session.auth);
      if (!report || report.runId !== runId) {
        throw new Error("This reporting turn cannot resume that run.");
      }
      return getScheduledAgentRunInputForReport(
        report.runId,
        report.leaseToken
      );
    },
  });
  return resolvePending?.();
}
