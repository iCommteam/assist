import { createHash, randomUUID } from "node:crypto";
import { JWT } from "google-auth-library";
import { z } from "zod";
import type { bigqueryConfig } from "@shared/environment";

// The company's BigQuery over its REST API, read only, for the tools in
// agent/tools/bigquery.ts. The service account's roles are the real fence
// (BigQuery Data Viewer on the allowed datasets, BigQuery Job User on the
// project); this file is the second one, and it fails closed. A query runs
// only when its text names nothing the dry run's lists can leave out, its dry
// run says it is one SELECT that reads tables, views, graphs and routines of
// the allowed datasets alone, at most the byte cap, every routine it calls is
// a plain SQL or JavaScript function, and it then runs with that cap as
// maximumBytesBilled. Nothing here logs or returns the key, the account's
// address, the access token, or an error object: only fixed messages, and
// BigQuery's own error text and result values, cleaned of all of them.

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
const maxResultColumns = 100;
const maxColumnNameLength = 128;
const maxRoutines = 10;
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
  return bounded(hidden(text, config, token), maxErrorLength);
}

// The text with the key, its id, the account's address and the token taken
// out: for error text, and for every name and value a query returns.
function hidden(text: string, config: BigqueryConfig, token?: string) {
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
  return clean;
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

const routineReferenceSchema = z.object({
  datasetId: z.string(),
  projectId: z.string(),
  routineId: z.string(),
});

// The Job resource's statistics.query. A view is listed under
// referencedLogicalViews, apart from the base tables under referencedTables,
// and a graph under referencedPropertyGraphs; all four lists are checked.
const dryRunSchema = z.object({
  statistics: z
    .object({
      query: z
        .object({
          referencedLogicalViews: z.array(tableReferenceSchema).optional(),
          referencedPropertyGraphs: z.array(tableReferenceSchema).optional(),
          referencedRoutines: z.array(routineReferenceSchema).optional(),
          referencedTables: z.array(tableReferenceSchema).optional(),
          statementType: z.string().optional(),
          totalBytesProcessed: z.string().optional(),
        })
        .optional(),
      totalBytesProcessed: z.string().optional(),
    })
    .optional(),
});

// A routine as routines.get describes it. Its kind and language are kept;
// every other field stays too, so a field naming a runtime outside BigQuery
// (remoteFunctionOptions, sparkOptions and any later one) can be refused.
const routineSchema = z.looseObject({
  language: z.string().optional(),
  routineType: z.string().optional(),
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
  checkText(input.sql);
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
  await checkRoutines(
    config,
    dryRun.statistics?.query?.referencedRoutines ?? [],
    signal
  );

  // The job's id is chosen here, so a job whose start or wait fails, times
  // out or is cancelled can be cancelled by it.
  const jobId = `assist_${randomUUID().replaceAll("-", "")}`;
  let results: z.infer<typeof resultsSchema>;
  try {
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
    results = await waitForResults(config, jobId, signal);
  } catch (error) {
    await cancelJob(config, jobId);
    throw error;
  }

  // At most 100 columns, each name bounded, so the header alone always fits
  // the output bound; every name and value is cleaned of the key, its id
  // and the account's address.
  const allFields = results.schema?.fields ?? [];
  const fields = allFields.slice(0, maxResultColumns);
  const clean = (text: string) => hidden(text, config);
  const rows = (results.rows ?? [])
    .slice(0, maxQueryRows)
    .map((row) =>
      fields.map((field, at) => cellOf(field, row.f[at]?.v, clean))
    );
  const totalRows = Number(results.totalRows ?? rows.length);
  return fitted(
    {
      columns: fields.map((field) =>
        bounded(clean(field.name), maxColumnNameLength)
      ),
      ...(allFields.length > fields.length
        ? {
            moreColumns: `Only the first ${String(fields.length)} of ${String(allFields.length)} columns are shown. Select only the columns you need.`,
          }
        : undefined),
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

// What the dry run's lists can leave out, refused by the statement's own text
// before anything runs: INFORMATION_SCHEMA and its region qualifier, which
// read job history and other datasets' metadata; EXTERNAL_QUERY, which reads
// another database through a connection; ML, AI and OBJ functions and the
// models they name, which reach models, connections and Cloud Storage;
// GRAPH_TABLE; and SESSION_USER, the account's own address. The text is read
// twice, as written and with its comments taken out, each time with its
// backquotes as spaces and the spaces around dots dropped, so a quoted,
// split or spaced name is still found. Names in string literals are refused
// too. A quoted name takes a string's escapes, so one with a backslash, which
// could spell any of these, is refused whole.
const refusedNames = [
  [/INFORMATION_SCHEMA/iu, "INFORMATION_SCHEMA"],
  [/\bregion-/iu, "a region qualifier"],
  [/\bEXTERNAL_QUERY\b/iu, "EXTERNAL_QUERY"],
  [/\b(?:ML|AI|OBJ)\./iu, "an ML, AI or OBJ function"],
  [/\bMODEL\s+[\w-]+\./iu, "a model"],
  [/\bGRAPH_TABLE\b/iu, "GRAPH_TABLE"],
  [/\bSESSION_USER\b/iu, "SESSION_USER"],
] as const;

function checkText(sql: string) {
  const code = codeOf(sql);
  if (code === undefined) {
    throw new BigqueryError(
      "Refused: a backquoted name holds a backslash, or a quote or comment is never closed. Write each name plainly."
    );
  }
  const texts = [sql, code].map((text) =>
    text.replaceAll("`", " ").replaceAll(/\s*\.\s*/gu, ".")
  );
  for (const [pattern, what] of refusedNames) {
    if (texts.some((text) => pattern.test(text))) {
      throw new BigqueryError(
        `Refused: the query uses ${what}, which bigquery_query never runs. Read only the allowed datasets' tables; bigquery_list_tables and bigquery_describe_table say what exists.`
      );
    }
  }
}

// The statement with its comments as spaces, as GoogleSQL reads it: a
// comment starts at --, # or /* outside a string or a backquoted name, and a
// backslash in a string keeps the next character in it, raw or not.
// Undefined for a backquoted name with a backslash, or a string, name or
// comment left open.
function codeOf(sql: string) {
  let code = "";
  let at = 0;
  while (at < sql.length) {
    const char = sql.charAt(at);
    const pair = sql.slice(at, at + 2);
    if (pair === "--" || char === "#") {
      const end = sql.indexOf("\n", at);
      at = end === -1 ? sql.length : end;
      code += " ";
    } else if (pair === "/*") {
      const end = sql.indexOf("*/", at + 2);
      if (end === -1) return undefined;
      at = end + 2;
      code += " ";
    } else if (char === "`") {
      const end = sql.indexOf("`", at + 1);
      if (end === -1 || sql.slice(at, end).includes("\\")) return undefined;
      code += sql.slice(at, end + 1);
      at = end + 1;
    } else if (char === "'" || char === '"') {
      const quote = sql.startsWith(char.repeat(3), at) ? char.repeat(3) : char;
      let end = at + quote.length;
      while (end < sql.length && !sql.startsWith(quote, end)) {
        end += sql.charAt(end) === "\\" ? 2 : 1;
      }
      if (end >= sql.length) return undefined;
      code += sql.slice(at, end + quote.length);
      at = end + quote.length;
    } else {
      code += char;
      at += 1;
    }
  }
  return code;
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
  const outside = [
    ...tables,
    ...(statistics?.referencedLogicalViews ?? []),
    ...(statistics?.referencedPropertyGraphs ?? []),
    ...(statistics?.referencedRoutines ?? []),
  ].find(
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

// Every saved routine the query calls, read with routines.get, must be a
// SQL or JavaScript function, scalar, aggregate or table-valued, that runs
// inside BigQuery: a remote function calls an endpoint with the query's
// values, and a Python or Spark routine runs code elsewhere. A routine that
// cannot be read is refused. A temporary function written in the query is
// not a saved routine and is not listed.
const plainRoutineTypes = new Set([
  "AGGREGATE_FUNCTION",
  "SCALAR_FUNCTION",
  "TABLE_VALUED_FUNCTION",
]);
const plainLanguages = new Set(["JAVASCRIPT", "SQL"]);

async function checkRoutines(
  config: BigqueryConfig,
  references: readonly z.infer<typeof routineReferenceSchema>[],
  signal: AbortSignal
) {
  const routines = [
    ...new Map(
      references.map((reference) => [
        `${reference.datasetId}.${reference.routineId}`,
        reference,
      ])
    ).values(),
  ];
  if (routines.length > maxRoutines) {
    throw new BigqueryError(
      `Refused: the query calls ${String(routines.length)} saved routines, over ${String(maxRoutines)}.`
    );
  }
  for (const { datasetId, routineId } of routines) {
    const name = `${config.project}.${datasetId}.${routineId}`;
    let routine: z.infer<typeof routineSchema>;
    try {
      routine = routineSchema.parse(
        // oxlint-disable-next-line eslint/no-await-in-loop -- At most 10 routines, read one at a time.
        await call(config, {
          method: "GET",
          path: `/datasets/${encodeURIComponent(datasetId)}/routines/${encodeURIComponent(routineId)}`,
          signal,
        })
      );
    } catch {
      throw new BigqueryError(
        `Refused: the routine ${name} could not be read, so the query does not run.`
      );
    }
    const plain =
      plainRoutineTypes.has(routine.routineType ?? "") &&
      plainLanguages.has(routine.language ?? "SQL") &&
      !Object.keys(routine).some((key) => key.endsWith("Options"));
    if (!plain) {
      throw new BigqueryError(
        `Refused: the query calls ${name}, which is not a SQL or JavaScript function that runs inside BigQuery.`
      );
    }
  }
}

// The first page of the job's results, once BigQuery says the job is
// complete, waiting at most 60 seconds from the start; the caller cancels a
// job still running then.
async function waitForResults(
  config: BigqueryConfig,
  jobId: string,
  signal: AbortSignal
) {
  const deadline = Date.now() + queryTimeoutMs;
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
    if (results.jobComplete === true) return results;
    if (Date.now() >= deadline) {
      throw new BigqueryError(
        `The query ran longer than ${String(queryTimeoutMs / 1000)} seconds and was stopped. Make it smaller.`
      );
    }
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
// list, a timestamp as an ISO time, every other value as BigQuery's own text,
// cleaned and bounded.
function cellOf(
  field: Column,
  value: z.infer<ReturnType<typeof z.json>> | undefined,
  clean: (text: string) => string
): Cell {
  if (field.mode === "REPEATED") {
    const items = z.array(cellSchema).safeParse(value);
    return items.success
      ? items.data.map(({ v }) =>
          cellOf({ ...field, mode: "NULLABLE" }, v, clean)
        )
      : null;
  }
  if (field.type === "RECORD" || field.type === "STRUCT") {
    const record = recordSchema.safeParse(value);
    if (!record.success) return null;
    return Object.fromEntries(
      (field.fields ?? []).map((child, at) => [
        bounded(clean(child.name), maxColumnNameLength),
        cellOf(child, record.data.f[at]?.v, clean),
      ])
    );
  }
  const text = z.string().safeParse(value);
  if (!text.success) return null;
  if (field.type === "TIMESTAMP") return isoOfTimestamp(text.data);
  return bounded(clean(text.data), maxCellLength);
}

// The results are asked for with useInt64Timestamp, so a timestamp is whole
// microseconds; without it BigQuery writes seconds as a float, such as
// 1.764E9, which is read as seconds.
function isoOfTimestamp(value: string) {
  const millis = /^-?\d+$/u.test(value)
    ? Number(value) / 1000
    : Number(value) * 1000;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : value;
}

function isoOfMillis(millis: string) {
  const time = Number(millis);
  return Number.isFinite(time) ? new Date(time).toISOString() : millis;
}

// A result cut to the output bound: the items of its one list (rows,
// tables or columns) are dropped from the end until it fits, and the result
// says so. One that does not fit even with none is refused.
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
  const shown = cut();
  if (JSON.stringify(shown).length > maxOutputLength) {
    throw new BigqueryError(
      `The result is wider than ${String(maxOutputLength)} characters even without its ${key}. Select fewer columns, with shorter names.`
    );
  }
  return shown;
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
