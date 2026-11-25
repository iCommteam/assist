import { createHash, randomUUID } from "node:crypto";
import { JWT } from "google-auth-library";
import { z } from "zod";
import type { bigqueryConfig } from "@shared/environment";

// The company's BigQuery over its REST API, read only, for the tools in
// agent/tools/bigquery.ts. The service account's roles are the real fence
// (BigQuery Data Viewer on the allowed datasets, BigQuery Job User on the
// project); this file is the second one. A query runs only after its dry run
// says it is one SELECT that reads tables of the allowed datasets alone, and
// at most the byte cap; it then runs with that cap as maximumBytesBilled.
// Nothing here logs or returns the key, the access token, or an error object:
// only fixed messages and BigQuery's own error text, cleaned of both.

type BigqueryConfig = NonNullable<ReturnType<typeof bigqueryConfig>>;

const apiOrigin = "https://bigquery.googleapis.com";
// jobs.insert, which runs the dry run and the query, accepts no read-only
// scope; the account's roles keep it read only.
const bigqueryScope = "https://www.googleapis.com/auth/bigquery";
const requestTimeoutMs = 20_000;
const queryTimeoutMs = 60_000;
const resultsWaitMs = 10_000;
export const maxQueryRows = 200;
export const maxSqlLength = 20_000;
const maxTables = 1000;
const maxColumns = 400;
const maxOutputLength = 20_000;
const maxCellLength = 500;
const maxErrorLength = 600;

// A refusal or failure whose message is fit for the model: fixed text, or
// BigQuery's own error text with the key and the token taken out.
export class BigqueryError extends Error {
  override name = "BigqueryError";
}

// --- Sign-in ---------------------------------------------------------------

let signer: { readonly client: JWT; readonly privateKey: string } | undefined;

async function accessToken(config: BigqueryConfig) {
  const { clientEmail, privateKey, privateKeyId } = config.credentials;
  if (signer?.privateKey !== privateKey) {
    signer = {
      client: new JWT({
        email: clientEmail,
        key: privateKey,
        keyId: privateKeyId,
        scopes: [bigqueryScope],
      }),
      privateKey,
    };
  }
  try {
    const { token } = await signer.client.getAccessToken();
    if (token) return token;
  } catch (error) {
    console.warn("[bigquery] the service account could not sign in", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  throw new BigqueryError(
    "BigQuery refused the service account's sign-in. Ask an administrator to check ASSIST_BIGQUERY_KEY."
  );
}

// --- One call ----------------------------------------------------------------

const googleErrorSchema = z.object({
  error: z.object({ message: z.string() }),
});

async function call(
  config: BigqueryConfig,
  request: {
    readonly body?: z.infer<ReturnType<typeof z.json>>;
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  }
) {
  const token = await accessToken(config);
  const url = new URL(
    `/bigquery/v2/projects/${encodeURIComponent(config.project)}${request.path}`,
    apiOrigin
  );
  for (const [name, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(name, value);
  }
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${token}`,
  });
  if (request.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      body:
        request.body === undefined ? undefined : JSON.stringify(request.body),
      headers,
      method: request.method,
      redirect: "error",
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(requestTimeoutMs),
      ]),
    });
  } catch {
    throw new BigqueryError(
      request.signal.aborted
        ? "The BigQuery call was cancelled."
        : "BigQuery cannot be reached right now. Try again in a minute."
    );
  }
  const json = await readJson(response);
  if (response.ok) return json;
  const refusal = googleErrorSchema.safeParse(json);
  throw new BigqueryError(
    refusal.success
      ? `BigQuery: ${cleaned(refusal.data.error.message, config, token)}`
      : `BigQuery refused the call with HTTP ${String(response.status)}.`
  );
}

async function readJson(response: Response) {
  try {
    return z.json().parse(await response.json());
  } catch {
    return null;
  }
}

// BigQuery's own error text, such as a syntax error's line and column,
// without the key, the account's address or the token, and bounded.
function cleaned(
  text: string,
  config: BigqueryConfig,
  token: string | undefined
) {
  const { clientEmail, privateKey, privateKeyId } = config.credentials;
  const secrets = [
    privateKey,
    ...privateKey.split(/\r?\n|\\n/u).filter((line) => line.length >= 16),
    privateKeyId,
    clientEmail,
    token,
  ].filter((secret): secret is string => secret !== undefined);
  let clean = text;
  for (const secret of secrets) clean = clean.replaceAll(secret, "[hidden]");
  return bounded(clean, maxErrorLength);
}

function bounded(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// --- Tables ------------------------------------------------------------------

const tableListSchema = z.object({
  nextPageToken: z.string().optional(),
  tables: z
    .array(
      z.object({
        tableReference: z.object({ tableId: z.string() }),
        type: z.string().optional(),
      })
    )
    .optional(),
  totalItems: z.number().optional(),
});

export async function listTables(
  config: BigqueryConfig,
  input: { readonly dataset: string; readonly pageToken?: string },
  signal: AbortSignal
) {
  checkDataset(config, input.dataset);
  const list = tableListSchema.parse(
    await call(config, {
      method: "GET",
      path: `/datasets/${encodeURIComponent(input.dataset)}/tables`,
      query: {
        maxResults: String(maxTables),
        ...(input.pageToken === undefined
          ? undefined
          : { pageToken: input.pageToken }),
      },
      signal,
    })
  );
  const tables = (list.tables ?? []).map(({ tableReference, type }) =>
    type === undefined || type === "TABLE"
      ? tableReference.tableId
      : `${tableReference.tableId} (${type.toLowerCase().replaceAll("_", " ")})`
  );
  return fitted(
    {
      dataset: `${config.project}.${input.dataset}`,
      tables,
      ...(list.totalItems === undefined
        ? undefined
        : { total: list.totalItems }),
      ...(list.nextPageToken === undefined
        ? undefined
        : {
            more: "More tables exist: call again with this pageToken.",
            pageToken: list.nextPageToken,
          }),
    },
    "tables"
  );
}

interface Column {
  readonly description?: string;
  readonly fields?: readonly Column[];
  readonly mode?: string;
  readonly name: string;
  readonly type: string;
}

const columnSchema: z.ZodType<Column> = z.object({
  description: z.string().optional(),
  get fields() {
    return z.array(columnSchema).optional();
  },
  mode: z.string().optional(),
  name: z.string(),
  type: z.string(),
});

const tableSchema = z.object({
  clustering: z.object({ fields: z.array(z.string()) }).optional(),
  description: z.string().optional(),
  lastModifiedTime: z.string().optional(),
  numBytes: z.string().optional(),
  numRows: z.string().optional(),
  rangePartitioning: z.object({ field: z.string() }).optional(),
  schema: z.object({ fields: z.array(columnSchema) }).optional(),
  timePartitioning: z
    .object({ field: z.string().optional(), type: z.string() })
    .optional(),
  type: z.string().optional(),
  view: z.object({ query: z.string() }).optional(),
});

export async function describeTable(
  config: BigqueryConfig,
  input: { readonly dataset: string; readonly table: string },
  signal: AbortSignal
) {
  checkDataset(config, input.dataset);
  const table = tableSchema.parse(
    await call(config, {
      method: "GET",
      path: `/datasets/${encodeURIComponent(input.dataset)}/tables/${encodeURIComponent(input.table)}`,
      signal,
    })
  );
  const columns = flatColumns(table.schema?.fields ?? [], "");
  const partitioning = table.timePartitioning
    ? `${table.timePartitioning.type.toLowerCase()} on ${table.timePartitioning.field ?? "_PARTITIONTIME"}`
    : table.rangePartitioning
      ? `range on ${table.rangePartitioning.field}`
      : undefined;
  return fitted(
    {
      table: `${config.project}.${input.dataset}.${input.table}`,
      type: table.type ?? "TABLE",
      ...(table.numRows === undefined ? undefined : { rows: table.numRows }),
      ...(table.numBytes === undefined ? undefined : { bytes: table.numBytes }),
      ...(table.lastModifiedTime === undefined
        ? undefined
        : { lastModified: isoOfMillis(table.lastModifiedTime) }),
      ...(partitioning === undefined ? undefined : { partitioning }),
      ...(table.clustering
        ? { clusteredBy: table.clustering.fields }
        : undefined),
      ...(table.description === undefined
        ? undefined
        : { description: bounded(table.description, maxCellLength) }),
      columns: columns.slice(0, maxColumns),
      ...(columns.length > maxColumns
        ? {
            more: `Only the first ${String(maxColumns)} of ${String(columns.length)} columns are shown.`,
          }
        : undefined),
      ...(table.view === undefined
        ? undefined
        : { viewQuery: bounded(table.view.query, 4000) }),
    },
    "columns"
  );
}

// The tools' schemas allow only the listed datasets; this holds for any
// other caller too.
function checkDataset(config: BigqueryConfig, dataset: string) {
  if (config.datasets.includes(dataset)) return;
  throw new BigqueryError(
    `Refused: ${dataset} is not one of the allowed datasets, ${config.datasets.join(", ")}.`
  );
}

// Nested columns as dotted names, in their order: one line each.
function flatColumns(fields: readonly Column[], prefix: string): string[] {
  return fields.flatMap((field) => {
    const name = `${prefix}${field.name}`;
    const mode =
      field.mode === undefined || field.mode === "NULLABLE"
        ? ""
        : ` ${field.mode.toLowerCase()}`;
    const description = field.description
      ? `: ${bounded(field.description, 200)}`
      : "";
    return [
      `${name} ${field.type.toLowerCase()}${mode}${description}`,
      ...flatColumns(field.fields ?? [], `${name}.`),
    ];
  });
}

// --- Queries -----------------------------------------------------------------

const tableReferenceSchema = z.object({
  datasetId: z.string(),
  projectId: z.string(),
});

const dryRunSchema = z.object({
  statistics: z
    .object({
      query: z
        .object({
          referencedRoutines: z.array(tableReferenceSchema).optional(),
          referencedTables: z.array(tableReferenceSchema).optional(),
          statementType: z.string().optional(),
          totalBytesProcessed: z.string().optional(),
        })
        .optional(),
      totalBytesProcessed: z.string().optional(),
    })
    .optional(),
});

const jobSchema = z.object({
  status: z
    .object({
      errorResult: z.object({ message: z.string() }).optional(),
      state: z.string().optional(),
    })
    .optional(),
});

const cellSchema = z.object({ v: z.json() });
const recordSchema = z.object({ f: z.array(cellSchema) });

const resultsSchema = z.object({
  jobComplete: z.boolean().optional(),
  rows: z.array(recordSchema).optional(),
  schema: z.object({ fields: z.array(columnSchema) }).optional(),
  totalBytesProcessed: z.string().optional(),
  totalRows: z.string().optional(),
});

// Runs one read-only Standard SQL statement, exactly the text that passed its
// dry run, and returns at most 200 rows as compact JSON.
export async function runQuery(
  config: BigqueryConfig,
  input: {
    readonly labels: Readonly<Record<string, string>>;
    readonly sql: string;
  },
  signal: AbortSignal
) {
  const location = config.location;
  const query = { query: input.sql, useLegacySql: false };
  const dryRun = dryRunSchema.parse(
    await call(config, {
      body: {
        configuration: { dryRun: true, labels: input.labels, query },
        jobReference: { location, projectId: config.project },
      },
      method: "POST",
      path: "/jobs",
      signal,
    })
  );
  const bytes = checkDryRun(config, dryRun);

  const jobId = `assist_${randomUUID().replaceAll("-", "")}`;
  const job = jobSchema.parse(
    await call(config, {
      body: {
        configuration: {
          jobTimeoutMs: String(queryTimeoutMs),
          labels: input.labels,
          query: { ...query, maximumBytesBilled: String(config.maxBytes) },
        },
        jobReference: { jobId, location, projectId: config.project },
      },
      method: "POST",
      path: "/jobs",
      signal,
    })
  );
  if (job.status?.errorResult) {
    throw new BigqueryError(
      `BigQuery: ${cleaned(job.status.errorResult.message, config, undefined)}`
    );
  }

  const results = await waitForResults(config, jobId, signal);
  const fields = results.schema?.fields ?? [];
  const rows = (results.rows ?? [])
    .slice(0, maxQueryRows)
    .map((row) => fields.map((field, at) => cellOf(field, row.f[at]?.v)));
  const totalRows = Number(results.totalRows ?? rows.length);
  return fitted(
    {
      columns: fields.map((field) => field.name),
      rows,
      totalRows,
      ...(totalRows > rows.length
        ? {
            more: `Only the first ${String(rows.length)} of ${String(totalRows)} rows are shown. Aggregate or filter in SQL to see the rest.`,
          }
        : undefined),
      bytesProcessed: results.totalBytesProcessed ?? String(bytes),
      jobId,
    },
    "rows"
  );
}

function checkDryRun(
  config: BigqueryConfig,
  dryRun: z.infer<typeof dryRunSchema>
) {
  const statistics = dryRun.statistics?.query;
  const statement = statistics?.statementType;
  if (statement !== "SELECT") {
    throw new BigqueryError(
      statement === undefined
        ? "Refused: BigQuery could not say what this statement does. Send one read-only SELECT statement."
        : `Refused: only one read-only SELECT statement may run, and this is ${statement}.`
    );
  }
  const tables = statistics?.referencedTables ?? [];
  if (tables.length === 0) {
    throw new BigqueryError(
      "Refused: the query reads no table of the allowed datasets. Use bigquery_list_tables and bigquery_describe_table for what exists."
    );
  }
  const outside = [...tables, ...(statistics?.referencedRoutines ?? [])].find(
    (reference) =>
      reference.projectId !== config.project ||
      !config.datasets.includes(reference.datasetId)
  );
  if (outside) {
    throw new BigqueryError(
      `Refused: the query reaches ${outside.projectId}.${outside.datasetId}, which is not one of ${config.datasets.map((dataset) => `${config.project}.${dataset}`).join(", ")}.`
    );
  }
  const bytes = Number(
    statistics?.totalBytesProcessed ??
      dryRun.statistics?.totalBytesProcessed ??
      Number.NaN
  );
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new BigqueryError(
      "Refused: BigQuery could not say how much this query reads."
    );
  }
  if (bytes > config.maxBytes) {
    throw new BigqueryError(
      `Refused: the query would read ${gibibytes(bytes)}, over the cap of ${gibibytes(config.maxBytes)}. Select fewer columns, filter on the partition or date column, or read a smaller table.`
    );
  }
  return bytes;
}

function gibibytes(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

// The first page of the job's results, waiting at most 60 seconds from the
// start; a job still running then is cancelled.
async function waitForResults(
  config: BigqueryConfig,
  jobId: string,
  signal: AbortSignal
) {
  const deadline = Date.now() + queryTimeoutMs;
  try {
    for (;;) {
      const results = resultsSchema.parse(
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each read waits on BigQuery until the job completes.
        await call(config, {
          method: "GET",
          path: `/queries/${encodeURIComponent(jobId)}`,
          query: {
            "formatOptions.useInt64Timestamp": "true",
            location: config.location,
            maxResults: String(maxQueryRows),
            timeoutMs: String(resultsWaitMs),
          },
          signal,
        })
      );
      if (results.jobComplete !== false) return results;
      if (Date.now() >= deadline) {
        throw new BigqueryError(
          `The query ran longer than ${String(queryTimeoutMs / 1000)} seconds and was stopped. Make it smaller.`
        );
      }
    }
  } catch (error) {
    await cancelJob(config, jobId);
    throw error;
  }
}

async function cancelJob(config: BigqueryConfig, jobId: string) {
  try {
    await call(config, {
      method: "POST",
      path: `/jobs/${encodeURIComponent(jobId)}/cancel`,
      query: { location: config.location },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    console.warn("[bigquery] a query could not be cancelled", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

type Cell = string | null | Cell[] | { readonly [name: string]: Cell };

// One value by its column: a record as an object, a repeated column as a
// list, a timestamp as an ISO time, every other value as BigQuery's own text.
function cellOf(
  field: Column,
  value: z.infer<ReturnType<typeof z.json>> | undefined
): Cell {
  if (field.mode === "REPEATED") {
    const items = z.array(cellSchema).safeParse(value);
    return items.success
      ? items.data.map(({ v }) => cellOf({ ...field, mode: "NULLABLE" }, v))
      : null;
  }
  if (field.type === "RECORD" || field.type === "STRUCT") {
    const record = recordSchema.safeParse(value);
    if (!record.success) return null;
    return Object.fromEntries(
      (field.fields ?? []).map((child, at) => [
        child.name,
        cellOf(child, record.data.f[at]?.v),
      ])
    );
  }
  const text = z.string().safeParse(value);
  if (!text.success) return null;
  if (field.type === "TIMESTAMP") return isoOfMicros(text.data);
  return bounded(text.data, maxCellLength);
}

function isoOfMicros(micros: string) {
  const millis = Number(micros) / 1000;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : micros;
}

function isoOfMillis(millis: string) {
  const time = Number(millis);
  return Number.isFinite(time) ? new Date(time).toISOString() : millis;
}

// A result cut to the output bound: the items of its one list (rows,
// tables or columns) are dropped from the end until it fits, and the result
// says so.
function fitted<
  const Key extends "columns" | "rows" | "tables",
  T extends Readonly<Record<Key, readonly (string | readonly Cell[])[]>>,
>(result: T, key: Key) {
  if (JSON.stringify(result).length <= maxOutputLength) return result;
  const items = [...result[key]];
  const cut = () => ({
    ...result,
    [key]: items,
    cut: `The result was cut to ${String(maxOutputLength)} characters: ${String(items.length)} ${key} are shown.`,
  });
  while (items.length > 0 && JSON.stringify(cut()).length > maxOutputLength) {
    items.pop();
  }
  return cut();
}

// The labels every job carries, so the team can find assist's jobs in
// BigQuery's job history: the app, the tool, the mode and a short hash of the
// member, never their id.
export function jobLabels(mode: string, principalId: string) {
  return {
    app: "assist",
    assist_member: createHash("sha256")
      .update(principalId)
      .digest("hex")
      .slice(0, 16),
    assist_mode: mode,
    assist_tool: "bigquery_query",
  };
}
