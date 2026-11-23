import { PGlite } from "@electric-sql/pglite";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Database from "@db";
import { withBrowserProfileWriteLock } from "@db/services/browsers";
import * as schema from "../schema";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser profile write lock", () => {
  it("runs the operation inside a Postgres advisory lock", async () => {
    const client = new PGlite();
    try {
      const pgliteDatabase = drizzle(client, { schema });
      // SAFETY: PGlite implements the transaction and execute surface this service uses despite using a different Drizzle driver.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
      const database = pgliteDatabase as never;
      vi.spyOn(Database, "db", "get").mockReturnValue(database);
      await expect(
        withBrowserProfileWriteLock("openinstinct-a", async () => "saved")
      ).resolves.toBe("saved");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("keys the lock by the profile name and refuses one already taken", async () => {
    const statements: SQL[] = [];
    let acquired = true;
    const transaction = {
      async execute(statement: SQL) {
        statements.push(statement);
        return { rows: [{ acquired }] };
      },
    };
    const fakeDatabase = {
      transaction: async (
        run: (value: typeof transaction) => Promise<string>
      ) => run(transaction),
    };
    // SAFETY: the lock uses only db.transaction and the transaction's execute.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fake supplies exactly the transaction surface withBrowserProfileWriteLock calls.
    const database = fakeDatabase as never;
    vi.spyOn(Database, "db", "get").mockReturnValue(database);
    const operation = vi.fn<() => Promise<string>>(async () => "saved");

    await withBrowserProfileWriteLock("openinstinct-login-a", operation);
    acquired = false;
    await expect(
      withBrowserProfileWriteLock("openinstinct-login-b", operation)
    ).rejects.toThrow(/starting to save sign-ins to this browser profile/u);

    const dialect = new PgDialect();
    expect(
      statements.map((statement) => dialect.sqlToQuery(statement).params)
    ).toEqual([["openinstinct-login-a"], ["openinstinct-login-b"]]);
    expect(operation).toHaveBeenCalledOnce();
  });
});
