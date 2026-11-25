import { drive, type drive_v3 } from "@googleapis/drive";
import { sheets } from "@googleapis/sheets";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { withGoogle } from "@agent/lib/google/client";
import { boundedText, untrustedNotice } from "@agent/lib/google/content";
import { requireGoogleScope } from "@agent/lib/google/offer";
import { googleToolsFor } from "@agent/lib/google/tools";

const service = "Google Drive";

const kinds = {
  document: "application/vnd.google-apps.document",
  folder: "application/vnd.google-apps.folder",
  pdf: "application/pdf",
  presentation: "application/vnd.google-apps.presentation",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
} as const;

const fileFields =
  "id,name,mimeType,modifiedTime,size,webViewLink,owners(displayName,emailAddress)";

// Read in full: what Drive exports as text, and plain files up to this size.
const plainFileLimitBytes = 2 * 1024 * 1024;
// Of a Sheet: its first tabs, and in each the rows and columns from A1 up to
// these. One more row and column are asked for, to tell whether a tab holds
// anything past them.
const sheetLimit = 10;
const sheetRows = 200;
const sheetColumns = 26;
const sheetRangePastLimits = "A1:AA201";

const driveSearch = defineTool({
  availableInSubagents: false,
  description:
    "Search the Google Drive files the member can open, shared drives included, by words in their name or content, most relevant first. Optionally only one kind of file. When nextPageToken is not null, more files match: pass it as pageToken for the next page. Read one with drive_read_file.",
  inputSchema: z.object({
    kind: z
      .enum(["any", "document", "spreadsheet", "presentation", "pdf", "folder"])
      .default("any"),
    maxResults: z.number().int().min(1).max(25).default(10),
    pageToken: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .optional()
      .describe("The nextPageToken of an earlier call, for the next page."),
    query: z.string().trim().min(1).max(200),
  }),
  label: { start: ({ query }) => `Search Google Drive for “${query}”` },
  async execute({ kind, maxResults, pageToken, query }, ctx) {
    requireGoogleScope(ctx);
    // The words are quoted into Drive's query language, never written into
    // it, so a search cannot widen itself.
    const clauses = [
      `fullText contains '${quoted(query)}'`,
      "trashed = false",
      ...(kind === "any" ? [] : [`mimeType = '${kinds[kind]}'`]),
    ];
    const listed = await withDrive(ctx, async (client) => {
      // No orderBy: Drive refuses to sort a fullText search, whose results
      // always come most relevant first.
      const { data } = await client.files.list(
        {
          corpora: "allDrives",
          fields: `nextPageToken,files(${fileFields})`,
          includeItemsFromAllDrives: true,
          pageSize: maxResults,
          pageToken,
          q: clauses.join(" and "),
          supportsAllDrives: true,
        },
        { signal: ctx.abortSignal }
      );
      return data;
    });
    return {
      files: (listed.files ?? []).map(fileSummary),
      nextPageToken: listed.nextPageToken ?? null,
    };
  },
});

const driveReadFile = defineTool({
  availableInSubagents: false,
  description:
    "Read one Google Drive file by its id from drive_search: a Google Doc or Slides as text, a Google Sheet as tab-separated rows (its first 10 tabs, and in each only rows 1 to 200 and columns A to Z), or a plain text or CSV file. For a Sheet, sheetLimits names each tab that holds more and how many tabs were not read; truncated is true whenever anything was left out. Other files, such as PDFs and images, return their details only.",
  inputSchema: z.object({
    fileId: z.string().trim().min(1).max(200),
    maxCharacters: z.number().int().min(1_000).max(50_000).default(20_000),
  }),
  label: { start: () => "Read a Google Drive file" },
  async execute({ fileId, maxCharacters }, ctx) {
    requireGoogleScope(ctx);
    const file = await withDrive(ctx, async (client) => {
      const { data } = await client.files.get(
        { fields: fileFields, fileId, supportsAllDrives: true },
        { signal: ctx.abortSignal }
      );
      return data;
    });
    const read = await fileText(ctx, file);
    if (read === undefined) {
      return {
        file: fileSummary(file),
        readable: false,
        reason:
          "This kind of file is not read here. Give the member its link instead.",
      };
    }
    const bounded = boundedText(read.text, maxCharacters);
    const { sheetLimits } = read;
    const sheetCut =
      sheetLimits !== null &&
      (sheetLimits.tabsNotRead > 0 || sheetLimits.tabsWithMore.length > 0);
    return {
      file: fileSummary(file),
      notice: untrustedNotice,
      readable: true,
      sheetLimits,
      text: bounded.text,
      truncated: bounded.truncated || sheetCut,
    };
  },
});

export default defineDynamic((context) =>
  googleToolsFor(context, {
    drive_read_file: { ability: "drive-read", tool: driveReadFile },
    drive_search: { ability: "drive-read", tool: driveSearch },
  })
);

async function fileText(ctx: ToolContext, file: drive_v3.Schema$File) {
  const fileId = file.id;
  if (!fileId) return undefined;
  switch (file.mimeType) {
    case kinds.document:
    case kinds.presentation:
      return withDrive(ctx, async (client) => {
        const { data } = await client.files.export(
          { fileId, mimeType: "text/plain" },
          { responseType: "text", signal: ctx.abortSignal }
        );
        return { sheetLimits: null, text: z.string().parse(data) };
      });
    case kinds.spreadsheet:
      return spreadsheetText(ctx, fileId);
    default:
      if (!isPlainText(file.mimeType ?? "")) return undefined;
      if (Number(file.size ?? 0) > plainFileLimitBytes) return undefined;
      return withDrive(ctx, async (client) => {
        const { data } = await client.files.get(
          { alt: "media", fileId, supportsAllDrives: true },
          { responseType: "text", signal: ctx.abortSignal }
        );
        return { sheetLimits: null, text: z.string().parse(data) };
      });
  }
}

// A Sheet's first tabs as tab-separated rows, and what was left out: the
// tabs past the first ten, and each tab holding a value past row 200 or
// column Z. Sheets returns a range without its empty trailing rows and
// columns, so a row or column past the limits arrives only when it holds a
// value.
async function spreadsheetText(ctx: ToolContext, spreadsheetId: string) {
  return withGoogle(ctx, service, async (auth) => {
    const client = sheets({ auth, version: "v4" });
    const { data } = await client.spreadsheets.get(
      { fields: "sheets.properties.title", spreadsheetId },
      { signal: ctx.abortSignal }
    );
    const allTitles = (data.sheets ?? []).flatMap((sheet) =>
      sheet.properties?.title ? [sheet.properties.title] : []
    );
    const titles = allTitles.slice(0, sheetLimit);
    const tabsNotRead = allTitles.length - titles.length;
    if (titles.length === 0) {
      return { sheetLimits: { tabsNotRead, tabsWithMore: [] }, text: "" };
    }
    const { data: values } = await client.spreadsheets.values.batchGet(
      {
        ranges: titles.map(
          (title) => `'${title.replaceAll("'", "''")}'!${sheetRangePastLimits}`
        ),
        spreadsheetId,
        valueRenderOption: "FORMATTED_VALUE",
      },
      { signal: ctx.abortSignal }
    );
    const tabs = (values.valueRanges ?? []).map((range, index) => {
      const read = range.values ?? [];
      return {
        more:
          read.length > sheetRows ||
          read.some((row) => row.length > sheetColumns),
        rows: read.slice(0, sheetRows).map((row) =>
          row
            .slice(0, sheetColumns)
            .map((cell) => String(cell ?? ""))
            .join("\t")
        ),
        title: titles[index] ?? "Sheet",
      };
    });
    return {
      sheetLimits: {
        tabsNotRead,
        tabsWithMore: tabs.flatMap(({ more, title }) => (more ? [title] : [])),
      },
      text: tabs
        .map(({ rows, title }) => `# ${title}\n${rows.join("\n")}`)
        .join("\n\n"),
    };
  });
}

function isPlainText(mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  );
}

// A single quote or backslash inside Drive's query string is escaped with a
// backslash.
function quoted(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function withDrive<T>(
  ctx: ToolContext,
  call: (client: ReturnType<typeof drive>) => Promise<T>
) {
  return withGoogle(ctx, service, (auth) =>
    call(drive({ auth, version: "v3" }))
  );
}

function fileSummary(file: drive_v3.Schema$File) {
  const owner = file.owners?.[0];
  return {
    id: file.id ?? null,
    kind:
      Object.entries(kinds).find(
        ([, mimeType]) => mimeType === file.mimeType
      )?.[0] ??
      file.mimeType ??
      null,
    link: file.webViewLink ?? null,
    modified: file.modifiedTime ?? null,
    name: file.name ?? null,
    owner: owner?.displayName ?? owner?.emailAddress ?? null,
  };
}
