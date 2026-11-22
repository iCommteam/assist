import { defineSchedule, type ScheduleToFn } from "eve/schedules";
import scheduledRunChannel from "@agent/channels/scheduled-run";
import { postScheduledReport } from "@agent/lib/schedules/request";
import { allowedUserIds } from "@db/services/auth/allowlist";
import {
  claimReadyScheduledAgentRuns,
  listRecoverableScheduledReports,
  materializeDueScheduledAgentRuns,
  releaseScheduledAgentRun,
  setScheduledRunSession,
} from "@db/services/scheduled-agent-jobs";

const workerStartupLimitMs = 5 * 60_000;

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    waitUntil(dispatchDueWork(to));
  },
});

async function dispatchDueWork(to: ScheduleToFn) {
  const now = new Date();
  // Runs and reports act as their creator with no live session, so only
  // creators whose email is still on the team list get work dispatched.
  const creatorIds = (await allowedUserIds()).map(
    (userId) => `better-auth:${userId}`
  );
  const materializedRunIds = await materializeDueScheduledAgentRuns({
    creatorIds,
    limit: 25,
    now,
  });
  const runs = await claimReadyScheduledAgentRuns({
    creatorIds,
    leaseForMs: workerStartupLimitMs,
    limit: 25,
    now,
  });
  const reports = await listRecoverableScheduledReports(creatorIds, now, 25);
  if (materializedRunIds.length > 0 || runs.length > 0 || reports.length > 0) {
    console.info("[scheduled-run] schedule tick found work", {
      claimedRunCount: runs.length,
      materializedRunCount: materializedRunIds.length,
      recoverableReportCount: reports.length,
    });
  }
  await Promise.all([
    ...runs.map((claim) => executeScheduledRun(to, claim)),
    ...reports.map((report) => postScheduledReport(report.runId)),
  ]);
}

async function executeScheduledRun(
  to: ScheduleToFn,
  claim: Awaited<ReturnType<typeof claimReadyScheduledAgentRuns>>[number]
) {
  const leaseToken = claim.run.leaseToken;
  if (!leaseToken) throw new Error("A scheduled run claim requires a lease.");
  console.info("[scheduled-run] dispatching worker", {
    attempt: claim.run.attempts,
    jobId: claim.job.id,
    runId: claim.run.id,
    scheduledFor: claim.run.scheduledFor.toISOString(),
  });
  try {
    const session = await to(scheduledRunChannel, {
      restart: claim.run.workerSessionId !== null,
      runId: claim.run.id,
    }).send(scheduledRunPrompt(claim), {
      auth: scheduledWorkerAuth(claim),
    });
    const persisted = await setScheduledRunSession(
      claim.run.id,
      leaseToken,
      session.sessionId
    );
    if (!persisted) {
      throw new Error("The scheduled run lease expired during dispatch.");
    }
    console.info("[scheduled-run] worker session accepted", {
      jobId: claim.job.id,
      runId: claim.run.id,
      sessionId: session.sessionId,
    });
  } catch (error) {
    console.warn("[scheduled-run] worker dispatch failed", {
      cause: error,
      jobId: claim.job.id,
      runId: claim.run.id,
    });
    const status = await releaseScheduledAgentRun(
      claim.run.id,
      leaseToken,
      error instanceof Error ? error.message : String(error)
    );
    if (status === "dead_letter") {
      await postScheduledReport(claim.run.id);
    }
  }
}

function scheduledRunPrompt(
  claim: Awaited<ReturnType<typeof claimReadyScheduledAgentRuns>>[number]
) {
  return [
    "Complete this user-owned scheduled task in an isolated background session.",
    `Scheduled for: ${claim.run.scheduledFor.toISOString()}`,
    `Task: ${claim.job.prompt}`,
  ].join("\n\n");
}

function scheduledWorkerAuth(
  claim: Awaited<ReturnType<typeof claimReadyScheduledAgentRuns>>[number]
) {
  const leaseToken = claim.run.leaseToken;
  if (!leaseToken) throw new Error("A scheduled run claim requires a lease.");
  return {
    attributes: {
      conversationChannel: claim.job.conversationChannel,
      conversationId: claim.job.conversationId,
      scheduleId: claim.job.id,
      scheduledRunLeaseToken: leaseToken,
      scheduledRunId: claim.run.id,
      workspaceId: claim.job.workspaceId,
    },
    authenticator: "scheduled-worker",
    issuer: "open-instinct",
    principalId: claim.job.createdByUserId,
    principalType: "user" as const,
  };
}
