import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { bigqueryAccess } from "@agent/lib/bigquery/access";
import {
  BigqueryError,
  describeTable,
  jobLabels,
  listTables,
  maxQueryRows,
  maxSqlLength,
  runQuery,
} from "@agent/lib/bigquery/client";

// The company's BigQuery, read only, in the web chat and in a full WhatsApp
// chat (agent/lib/bigquery/access.ts), and nowhere while ASSIST_BIGQUERY_KEY
// is unset. Each call checks the session again before it reads anything.

// A table name as BigQuery allows one: letters, marks, digits, connectors,
// dashes and spaces; never a decorator or a wildcard.
const tableNameSchema = z
  .string()
  .regex(/^[\p{L}\p{M}\p{N}\p{Pc}\p{Pd} ]{1,1024}$/u);

export default defineDynamic((context) => {
  const access = bigqueryAccess(context);
  if (!access) return null;
  const { datasets, location, maxBytes, project } = access.config;
  const datasetSchema = z
    .enum(datasets)
    .describe(`One of the allowed datasets of ${project}.`);
  const where = `${project} (${location}); datasets ${datasets.join(", ")}`;

  return {
    bigquery_describe_table: defineTool({
      availableInSubagents: false,
      description: `Read one table of the company's BigQuery (${where}): its columns with their types and descriptions, row count, size, partitioning, clustering and, for a view, its SQL. Read it before querying a table.`,
      inputSchema: z.object({ dataset: datasetSchema, table: tableNameSchema }),
      execute: async (input, ctx) =>
        guarded(ctx, ({ config }) =>
          describeTable(config, input, ctx.abortSignal)
        ),
    }),
    bigquery_list_tables: defineTool({
      availableInSubagents: false,
      description: `List the tables and views of one dataset of the company's BigQuery (${where}), up to 1,000 at a time; pass the pageToken a result gives to go on.`,
      inputSchema: z.object({
        dataset: datasetSchema,
        pageToken: z.string().min(1).max(2000).optional(),
      }),
      execute: async (input, ctx) =>
        guarded(ctx, ({ config }) =>
          listTables(config, input, ctx.abortSignal)
        ),
    }),
    bigquery_query: defineTool({
      availableInSubagents: false,
      description: `Run one read-only GoogleSQL (Standard SQL) SELECT statement on the company's BigQuery (${where}). Name each table in full, as \`${project}.<dataset>.<table>\`. A dry run checks it first: anything but one SELECT, a table, view or routine outside these datasets, or a query that would read more than ${(maxBytes / 1024 ** 3).toFixed(2)} GiB is refused, and so is any query naming INFORMATION_SCHEMA, EXTERNAL_QUERY, an ML, AI or OBJ function, GRAPH_TABLE or SESSION_USER. At most ${String(maxQueryRows)} rows come back; aggregate in SQL instead of reading raw rows.`,
      inputSchema: z.object({
        sql: z.string().trim().min(1).max(maxSqlLength),
      }),
      execute: async (input, ctx) =>
        guarded(ctx, ({ config, mode, principalId }) =>
          runQuery(
            config,
            { labels: jobLabels(mode, principalId), sql: input.sql },
            ctx.abortSignal
          )
        ),
    }),
  };
});

// Every call checks the session again, and fails with a message fit for the
// model: a refusal, or BigQuery's own error without the key or the token.
// Anything else is logged by name only.
async function guarded<T>(
  ctx: ToolContext,
  read: (access: NonNullable<ReturnType<typeof bigqueryAccess>>) => Promise<T>
) {
  const access = bigqueryAccess(ctx);
  if (!access) {
    throw new BigqueryError("BigQuery is not available in this chat.");
  }
  try {
    return await read(access);
  } catch (error) {
    if (error instanceof BigqueryError) throw error;
    console.warn("[bigquery] a call failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    throw new BigqueryError(
      "BigQuery answered in a way assist could not read. Try again, or make the request simpler."
    );
  }
}
