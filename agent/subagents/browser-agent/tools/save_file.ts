import { createHash } from "node:crypto";
import { NotFoundError } from "@onkernel/sdk";
import type { BrowserCurlResponse } from "@onkernel/sdk/resources/browsers";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import {
  purgeExpiredTaskFiles,
  saveSiteTaskFile,
  siteTaskFileRoom,
} from "@db/services/sites";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import {
  amazonPolicyRefusal,
  isAmazonHost,
  isInsideFence,
  siteNavigationFence,
  stripeInvoiceHosts,
} from "@agent/subagents/browser-agent/lib/policy/hosts";
import { assertWorkerNotBlocked } from "@agent/subagents/browser-agent/lib/policy/page-check";
import { siteLoginOfSession, siteOfSession } from "@agent/lib/site-principal";

const maxFileBytes = 20 * 1024 * 1024;
// The base64 text of the largest file, with room for line breaks.
const maxEncodedLength = Math.ceil(maxFileBytes / 3) * 4 + 4096;
const maxFilenameLength = 200;
const maxRedirects = 5;
const downloadTimeoutMs = 60_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const pdfSignature = Buffer.from("%PDF-", "latin1");

const notPinnedMessage =
  "Only a site task pinned to a saved login can save files.";
const notHttpsMessage =
  "save_file takes the absolute https URL of the PDF itself, such as the address of the invoice's Download PDF link.";
const offSiteMessage = `This file is neither on the pinned login's site nor on Stripe's invoice pages (${stripeInvoiceHosts.join(", ")}), so it was not fetched. Do not try another route to it. Delete the browser, then return status "failure" saying the invoice file is on a website this task may not open, so the task ends as off_site.`;
const closedMessage =
  'This site task has passed its 45 minutes, so it can save no more files. Delete the browser, then return status "failure" saying the task ran out of time.';
const fullMessage =
  "This task already keeps 10 files, the most it may save, so this one was not saved. Finish with the files saved so far.";
const notPdfMessage =
  "The URL did not return a PDF, so nothing was saved. It may be a web page: open it in the browser, find its Download PDF link, and save that link's address.";
const tooLargeMessage =
  "The file is larger than 20 MB, the most a task may save, so it was not saved.";
const redirectsMessage =
  "The file's URL redirected too many times, so nothing was saved.";
const browserGoneMessage =
  'The browser closed before the file was fetched. Return status "failure" saying the browser expired before the file was saved.';
const failedMessage =
  "The file could not be fetched or saved. Retry once; if it fails again, report the failure.";

// A refusal whose text is fixed here or names only a host. Anything else
// thrown on the way may quote the URL, the response or a database row.
class SaveRefusal extends Error {}

const inputSchema = z.object({
  browserSessionId: z.string().trim().min(1).max(500),
  filename: z.string().trim().min(1).max(500).optional(),
  url: z.string().trim().min(1).max(8000),
});

const outputSchema = z.object({
  alreadySaved: z.boolean(),
  byteSize: z.number().int(),
  fileId: z.string(),
  filename: z.string(),
});

const saveFile = defineTool({
  description: `In a site task pinned to a saved login, save one PDF, such as an invoice or a receipt, for the site to collect. Pass the browser that is signed in, the absolute https URL of the PDF itself (the address of its Download PDF link), and optionally a file name. The file is fetched through that browser, with its sign-in. The URL must be on the login's site or on one of Stripe's invoice hosts: ${stripeInvoiceHosts.join(", ")}. Only a PDF of at most 20 MB is kept, at most 10 per task, and the same file is kept once. Returns only the saved file's id, name and size.`,
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    const { initiator } = context.session.auth;
    const site = siteOfSession(initiator);
    const login = siteLoginOfSession(initiator);
    // The worker's root session is the site task's session.
    const taskSessionId = context.session.parent?.rootSessionId;
    if (!site || !login || !taskSessionId) throw new Error(notPinnedMessage);
    await requireOwnedBrowserSession(
      scope,
      context.session,
      input.browserSessionId
    );
    assertWorkerNotBlocked();
    const fence = siteNavigationFence(login.origin);

    try {
      const url = fileUrl(input.url, fence);
      const room = await siteTaskFileRoom(site, scope, taskSessionId);
      if (room !== "open") {
        throw new SaveRefusal(room === "full" ? fullMessage : closedMessage);
      }
      const fetched = await fetchFile(
        input.browserSessionId,
        url,
        fence,
        context.abortSignal,
        maxRedirects
      );
      const content = pdfContent(fetched.response);
      const filename = cleanFilename(
        input.filename ??
          dispositionFilename(
            header(fetched.response, "content-disposition")
          ) ??
          urlFilename(fetched.url)
      );
      await purgeExpiredTaskFiles();
      const saved = await saveSiteTaskFile(site, scope, taskSessionId, {
        content,
        filename,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
      if (!saved.ok) {
        throw new SaveRefusal(
          saved.reason === "full" ? fullMessage : closedMessage
        );
      }
      return { alreadySaved: saved.alreadySaved, ...saved.file };
    } catch (error) {
      if (error instanceof SaveRefusal) throw error;
      if (error instanceof NotFoundError) {
        // oxlint-disable-next-line eslint/preserve-caught-error -- Kernel's error text can quote the request.
        throw new Error(browserGoneMessage);
      }
      // Only the failure kind: the URL, the response and a failed row may
      // carry the file's link or contents.
      console.warn("[site] task file not saved", {
        error: error instanceof Error ? error.name : "unknown",
        site,
      });
      // oxlint-disable-next-line eslint/preserve-caught-error -- The cause may quote the file's URL or contents.
      throw new Error(failedMessage);
    }
  },
});

// Only pinned site tasks have the tool; every other worker never sees it.
export default defineDynamic((context) =>
  siteLoginOfSession(context.session.auth.initiator)
    ? { save_file: saveFile }
    : null
);

type SiteFence = ReturnType<typeof siteNavigationFence>;

// An https URL on the login's site or a Stripe invoice host, resolved against
// the URL that redirected to it.
function fileUrl(address: string, fence: SiteFence, base?: URL) {
  let url: URL;
  try {
    url = new URL(address, base);
  } catch {
    throw new SaveRefusal(notHttpsMessage);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new SaveRefusal(notHttpsMessage);
  }
  if (isAmazonHost(url.hostname)) {
    throw new SaveRefusal(amazonPolicyRefusal(url.hostname));
  }
  if (!isInsideFence(url.hostname, fence)) {
    throw new SaveRefusal(offSiteMessage);
  }
  return url;
}

// Fetched through the browser itself, so the request carries its sign-in. A
// redirect is followed only while it stays inside the fence.
async function fetchFile(
  browserSessionId: string,
  url: URL,
  fence: SiteFence,
  signal: AbortSignal | undefined,
  redirectsLeft: number
): Promise<{ response: BrowserCurlResponse; url: URL }> {
  const response = await kernel.browsers.curl(
    browserSessionId,
    {
      method: "GET",
      response_encoding: "base64",
      timeout_ms: downloadTimeoutMs,
      url: url.href,
    },
    { maxRetries: 0, signal, timeout: downloadTimeoutMs + 30_000 }
  );
  const location = redirectStatuses.has(response.status)
    ? header(response, "location")
    : undefined;
  if (location === undefined) return { response, url };
  if (redirectsLeft === 0) throw new SaveRefusal(redirectsMessage);
  return fetchFile(
    browserSessionId,
    fileUrl(location, fence, url),
    fence,
    signal,
    redirectsLeft - 1
  );
}

function header(response: BrowserCurlResponse, name: string) {
  return Object.entries(response.headers).find(
    ([key]) => key.toLowerCase() === name
  )?.[1][0];
}

function pdfContent(response: BrowserCurlResponse) {
  if (response.status !== 200) {
    throw new SaveRefusal(
      `The file's URL answered HTTP ${String(response.status)}, so nothing was saved. The link may have expired: open the page that links to the file again and save the link's current address.`
    );
  }
  if (response.body.length > maxEncodedLength) {
    throw new SaveRefusal(tooLargeMessage);
  }
  const content = Buffer.from(response.body, "base64");
  if (content.byteLength > maxFileBytes) throw new SaveRefusal(tooLargeMessage);
  if (!content.subarray(0, pdfSignature.byteLength).equals(pdfSignature)) {
    throw new SaveRefusal(notPdfMessage);
  }
  return content;
}

// The name a Content-Disposition header gives, its encoded form first.
function dispositionFilename(value: string | undefined) {
  if (value === undefined) return undefined;
  const encoded = /filename\*\s*=\s*[\w-]+'[^']*'([^;\s]+)/iu.exec(value)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // A malformed encoded name falls back to the plain one.
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/iu.exec(value);
  const quoted = plain?.[1]?.replaceAll(/\\(.)/gu, "$1");
  return quoted ?? plain?.[2]?.trim();
}

// A URL names the file only when its last path segment is a PDF's name.
function urlFilename(url: URL) {
  const segment = url.pathname.split("/").at(-1) ?? "";
  try {
    const name = decodeURIComponent(segment);
    return /\.pdf$/iu.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

// A plain file name: no path, no control or format characters, at most 200
// characters, ending in .pdf.
function cleanFilename(candidate: string | undefined) {
  const stem = trimmedStem(
    (candidate ?? "")
      .split(/[/\\]/u)
      .at(-1)
      ?.replaceAll(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu, " ")
      .replaceAll(/[<>:"|?*]+/gu, "_")
      .replaceAll(/\s+/gu, " ")
      .replace(/\.pdf$/iu, "") ?? ""
  );
  let kept = "";
  for (const character of stem || "document") {
    if (kept.length + character.length > maxFilenameLength - 4) break;
    kept += character;
  }
  return `${trimmedStem(kept) || "document"}.pdf`;
}

function trimmedStem(stem: string) {
  return stem.replaceAll(/^[\s.]+|[\s.]+$/gu, "");
}
