import type { ScheduleHandlerArgs } from "eve/schedules";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { purgeExpiredTaskFiles } from "@db/services/sites";

const services = vi.hoisted(() => ({
  purgeExpiredTaskFiles: vi.fn<typeof purgeExpiredTaskFiles>(),
}));

vi.mock("@db/services/sites", () => ({
  purgeExpiredTaskFiles: services.purgeExpiredTaskFiles,
}));

import taskFilesSchedule from "@agent/schedules/task-files";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

async function sweep() {
  let task: Promise<unknown> | undefined;
  const args: ScheduleHandlerArgs = {
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    to() {
      throw new Error("The sweep sends nothing.");
    },
    waitUntil(backgroundTask) {
      task = backgroundTask;
    },
  };
  taskFilesSchedule.run(args);
  await task;
}

describe("expired task file sweep", () => {
  it("runs every hour, whether or not a site calls", () => {
    expect(taskFilesSchedule.cron).toBe("17 * * * *");
  });

  it("deletes batches until none is left", async () => {
    services.purgeExpiredTaskFiles
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(0);

    await sweep();

    expect(services.purgeExpiredTaskFiles).toHaveBeenCalledTimes(4);
  });

  it("stops after twenty batches, leaving the rest for the next sweep", async () => {
    services.purgeExpiredTaskFiles.mockResolvedValue(100);

    await sweep();

    expect(services.purgeExpiredTaskFiles).toHaveBeenCalledTimes(20);
  });

  it("logs only the failure kind when the database cannot delete", async () => {
    services.purgeExpiredTaskFiles.mockRejectedValue(
      new Error("Failed query: delete from task_files where ... secret")
    );

    await sweep();

    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "[site] expired task files could not be swept",
      { error: "Error" }
    );
  });
});
