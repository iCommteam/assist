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
const sheetLimit = 10;
const sheetRange = "A1:Z200";

const driveSearch = defineTool({
  availableInSubagents: false,
  description:
    "Search the Google Drive files the member can open, shared drives included, by words in their name or content, newest first. Optionally only one kind of file. Read one with drive_read_file.",
  inputSchema: z.object({
    kind: z
      .enum(["any", "document", "spreadsheet", "presentation", "pdf", "folder"])
      .default("any"),
    maxResults: z.number().int().min(1).max(25).default(10),
    query: z.string().trim().min(1).max(200),
  }),
  label: { start: ({ query }) => `Search Google Drive for “${query}”` },
  async execute({ kind, maxResults, query }, ctx) {
    requireGoogleScope(ctx);
    // The words are quoted into Drive's query language, never written into
    // it, so a search cannot widen itself.
    const clauses = [
      `fullText contains '${quoted(query)}'`,
      "trashed = false",
      ...(kind === "any" ? [] : [`mimeType = '${kinds[kind]}'`]),
    ];
    const files = await withDrive(ctx, async (client) => {
      const { data } = await client.files.list(
        {
          corpora: "allDrives",
          fields: `files(${fileFields})`,
          includeItemsFromAllDrives: true,
          orderBy: "modifiedTime desc",
          pageSize: maxResults,
          q: clauses.join(" and "),
          supportsAllDrives: true,
        },
        { signal: ctx.abortSignal }
      );
      return data.files ?? [];
    });
    return { files: files.map(fileSummary) };
  },
});

const driveReadFile = defineTool({
  availableInSubagents: false,
  description:
    "Read one Google Drive file by its id from drive_search: a Google Doc or Slides as text, a Google Sheet as tab-separated rows (its first 10 tabs, 200 rows each), or a plain text or CSV file. Other files, such as PDFs and images, return their details only.",
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
    const text = await fileText(ctx, file);
    if (text === undefined) {
      return {
        file: fileSummary(file),
        readable: false,
        reason:
          "This kind of file is not read here. Give the member its link instead.",
      };
    }
    const bounded = boundedText(text, maxCharacters);
    return {
      file: fileSummary(file),
      notice: untrustedNotice,
      readable: true,
      text: bounded.text,
      truncated: bounded.truncated,
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
        return z.string().parse(data);
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
        return z.string().parse(data);
      });
  }
}

async function spreadsheetText(ctx: ToolContext, spreadsheetId: string) {
  return withGoogle(ctx, service, async (auth) => {
    const client = sheets({ auth, version: "v4" });
    const { data } = await client.spreadsheets.get(
      { fields: "sheets.properties.title", spreadsheetId },
      { signal: ctx.abortSignal }
    );
    const titles = (data.sheets ?? [])
      .flatMap((sheet) =>
        sheet.properties?.title ? [sheet.properties.title] : []
      )
      .slice(0, sheetLimit);
    if (titles.length === 0) return "";
    const { data: values } = await client.spreadsheets.values.batchGet(
      {
        ranges: titles.map(
          (title) => `'${title.replaceAll("'", "''")}'!${sheetRange}`
        ),
        spreadsheetId,
        valueRenderOption: "FORMATTED_VALUE",
      },
      { signal: ctx.abortSignal }
    );
    return (values.valueRanges ?? [])
      .map((range, index) => {
        const rows = (range.values ?? []).map((row) =>
          row.map((cell) => String(cell ?? "")).join("\t")
        );
        return `# ${titles[index] ?? "Sheet"}\n${rows.join("\n")}`;
      })
      .join("\n\n");
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
