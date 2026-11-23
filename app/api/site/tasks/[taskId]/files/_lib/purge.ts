import { purgeExpiredTaskFiles } from "@db/services/sites";

// Reads never return a file past its seven days, so a purge that fails only
// leaves its rows for the next one.
export async function purgeExpiredFiles(site: string) {
  try {
    await purgeExpiredTaskFiles();
  } catch (error) {
    console.warn("[site] expired task files could not be purged", {
      error: error instanceof Error ? error.name : "unknown",
      site,
    });
  }
}
