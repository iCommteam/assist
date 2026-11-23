import { defineSchedule } from "eve/schedules";
import { purgeExpiredTaskFiles } from "@db/services/sites";

// A site task's saved files are gone to every read after their seven days;
// this deletes their bytes even when no site calls again. Each sweep deletes
// a bounded number of batches, and the next one takes what is left.
const maxBatchesPerSweep = 20;

export default defineSchedule({
  cron: "17 * * * *",
  run({ waitUntil }) {
    waitUntil(sweepExpiredTaskFiles());
  },
});

async function sweepExpiredTaskFiles() {
  try {
    /* oxlint-disable eslint/no-await-in-loop -- Each batch is deleted after the one before it. */
    for (let batch = 0; batch < maxBatchesPerSweep; batch += 1) {
      if ((await purgeExpiredTaskFiles()) === 0) return;
    }
    /* oxlint-enable eslint/no-await-in-loop */
  } catch (error) {
    console.warn("[site] expired task files could not be swept", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}
