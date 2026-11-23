import { createHash } from "node:crypto";
import { NotFoundError } from "@onkernel/sdk";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import {
  purgeExpiredTaskFiles,
  saveSiteTaskFile,
  siteTaskFileRoom,
} from "@db/services/sites";
import { CdpConnection } from "@agent/subagents/browser-agent/lib/cdp";
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
const readChunkBytes = 1024 * 1024;
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
      const fetched = await downloadFile(
        input.browserSessionId,
        url,
        fence,
        context.abortSignal
      );
      const content = pdfContent(fetched.content);
      const filename = cleanFilename(
        input.filename ??
          dispositionFilename(fetched.disposition) ??
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

const createdTargetSchema = z.object({ targetId: z.string().min(1) });
const attachedTargetSchema = z.object({ sessionId: z.string().min(1) });
const navigatedSchema = z.object({ errorText: z.string().optional() });
const pausedRequestSchema = z.object({
  request: z.object({ url: z.string() }),
  requestId: z.string().min(1),
  responseErrorReason: z.string().optional(),
  responseHeaders: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .optional(),
  responseStatusCode: z.number().int().optional(),
});
const bodyStreamSchema = z.object({ stream: z.string().min(1) });
const bodyChunkSchema = z.object({
  base64Encoded: z.boolean().optional(),
  data: z.string(),
  eof: z.boolean(),
});

interface DownloadedFile {
  readonly content: Buffer;
  readonly disposition: string | undefined;
  readonly url: URL;
}

// Fetched by a navigation in a background tab of the signed-in browser, so the
// request carries its sign-in and Chrome's URL policy applies to every hop.
// Chromium follows redirects on its own, so every hop also pauses before it is
// sent and goes on only once it is checked against the fence here. The bytes
// come from the final answer itself, read no further than the size cap.
async function downloadFile(
  browserSessionId: string,
  url: URL,
  fence: SiteFence,
  signal: AbortSignal | undefined
) {
  const deadline = AbortSignal.timeout(downloadTimeoutMs);
  const stopped = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const browser = await kernel.browsers.retrieve(
    browserSessionId,
    {},
    { signal: stopped }
  );
  const connection = await connectUntil(browser.cdp_ws_url, stopped);
  try {
    const { targetId } = createdTargetSchema.parse(
      await connection.send("Target.createTarget", {
        background: true,
        url: "about:blank",
      })
    );
    // The tab is closed whatever happens: a leftover tab would be the newest
    // page, which other tools take for the worker's own.
    try {
      const { sessionId } = attachedTargetSchema.parse(
        await connection.send("Target.attachToTarget", {
          flatten: true,
          targetId,
        })
      );
      return await interceptedDownload(
        connection,
        sessionId,
        url,
        fence,
        stopped
      );
    } finally {
      await connection
        .send("Target.closeTarget", { targetId })
        .catch(() => undefined);
    }
  } finally {
    connection.close();
  }
}

// The stop signal ends only the connecting: once connected, the tab must still
// be closed over this connection after a stop.
async function connectUntil(url: string, stopped: AbortSignal) {
  const connecting = new AbortController();
  const stop = () => {
    connecting.abort(stopped.reason);
  };
  stopped.addEventListener("abort", stop, { once: true });
  try {
    return await CdpConnection.connect(url, connecting.signal);
  } finally {
    stopped.removeEventListener("abort", stop);
  }
}

function interceptedDownload(
  connection: CdpConnection,
  sessionId: string,
  url: URL,
  fence: SiteFence,
  stopped: AbortSignal
) {
  return new Promise<DownloadedFile>((resolve, reject) => {
    let requests = 0;
    let settled = false;
    // A refusal decided before the browser reports the navigation's end.
    let refused: SaveRefusal | undefined;

    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      stopped.removeEventListener("abort", onStopped);
      outcome();
    };
    const fail = (error: Error) => {
      settle(() => {
        reject(error);
      });
    };
    const onStopped = () => {
      fail(new Error("The download was stopped."));
    };

    // A refused request is failed before the refusal settles, so it is never
    // sent, whatever becomes of the tab.
    const refuse = async (requestId: string, refusal: SaveRefusal) => {
      refused = refusal;
      await connection
        .send(
          "Fetch.failRequest",
          { errorReason: "BlockedByClient", requestId },
          sessionId
        )
        .catch(() => undefined);
      fail(refusal);
    };

    // The URL a request is about to be sent to, or the one a redirect names.
    const checkedHop = async (
      requestId: string,
      address: string,
      base?: URL
    ) => {
      try {
        if (requests > maxRedirects + 1) {
          throw new SaveRefusal(redirectsMessage);
        }
        fileUrl(address, fence, base);
      } catch (error) {
        if (!(error instanceof SaveRefusal)) throw error;
        await refuse(requestId, error);
        return;
      }
      await connection.send("Fetch.continueRequest", { requestId }, sessionId);
    };

    const onPaused = async (paused: z.infer<typeof pausedRequestSchema>) => {
      const { requestId } = paused;
      if (paused.responseErrorReason !== undefined) {
        fail(new Error("The file's request failed."));
        return;
      }
      if (paused.responseStatusCode === undefined) {
        requests += 1;
        await checkedHop(requestId, paused.request.url);
        return;
      }
      const status = paused.responseStatusCode;
      const headers = paused.responseHeaders ?? [];
      const location = redirectStatuses.has(status)
        ? header(headers, "location")
        : undefined;
      if (location !== undefined) {
        await checkedHop(requestId, location, new URL(paused.request.url));
        return;
      }
      if (status !== 200) {
        throw new SaveRefusal(
          `The file's URL answered HTTP ${String(status)}, so nothing was saved. The link may have expired: open the page that links to the file again and save the link's current address.`
        );
      }
      const answeredUrl = fileUrl(paused.request.url, fence);
      const declaredLength = Number(header(headers, "content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxFileBytes) {
        throw new SaveRefusal(tooLargeMessage);
      }
      const content = await readBody(connection, sessionId, requestId);
      settle(() => {
        resolve({
          content,
          disposition: header(headers, "content-disposition"),
          url: answeredUrl,
        });
      });
    };

    const handlePaused = async (
      paused: z.infer<typeof pausedRequestSchema>
    ) => {
      try {
        await onPaused(paused);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Not fetched."));
      }
    };

    // Each pause holds its request, so the next one comes only after this
    // one is answered.
    const unsubscribe = connection.onEvent((event) => {
      if (settled || event.sessionId !== sessionId) return;
      if (event.method !== "Fetch.requestPaused") return;
      const paused = pausedRequestSchema.safeParse(event.params);
      if (!paused.success) {
        fail(new Error("The browser reported an unreadable request."));
        return;
      }
      void handlePaused(paused.data);
    });
    stopped.addEventListener("abort", onStopped, { once: true });
    if (stopped.aborted) {
      onStopped();
      return;
    }

    const watchConnection = async () => {
      await connection.closed;
      fail(new Error("The browser connection closed."));
    };
    // The navigation ends on its own only when the file was never taken:
    // Chrome's URL policy blocked a hop, or the request failed.
    const navigate = async () => {
      let navigated: Awaited<ReturnType<typeof connection.send>>;
      try {
        await connection.send(
          "Fetch.enable",
          {
            patterns: (["Request", "Response"] as const).map(
              (requestStage) => ({
                requestStage,
                resourceType: "Document",
                urlPattern: "*",
              })
            ),
          },
          sessionId
        );
        navigated = await connection.send(
          "Page.navigate",
          { url: url.href },
          sessionId,
          downloadTimeoutMs
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Not fetched."));
        return;
      }
      const errorText = navigatedSchema.safeParse(navigated).data?.errorText;
      fail(
        refused ??
          (errorText?.includes("ERR_BLOCKED_BY_ADMINISTRATOR") === true
            ? new SaveRefusal(offSiteMessage)
            : new Error("The navigation ended without the file."))
      );
    };
    void watchConnection();
    void navigate();
  });
}

async function readBody(
  connection: CdpConnection,
  sessionId: string,
  requestId: string
) {
  const { stream } = bodyStreamSchema.parse(
    await connection.send(
      "Fetch.takeResponseBodyAsStream",
      { requestId },
      sessionId
    )
  );
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    /* oxlint-disable eslint/no-await-in-loop -- The stream reads in order, one chunk at a time. */
    for (;;) {
      const chunk = bodyChunkSchema.parse(
        await connection.send(
          "IO.read",
          { handle: stream, size: readChunkBytes },
          sessionId
        )
      );
      const bytes = Buffer.from(
        chunk.data,
        chunk.base64Encoded === true ? "base64" : "utf8"
      );
      length += bytes.byteLength;
      if (length > maxFileBytes) throw new SaveRefusal(tooLargeMessage);
      chunks.push(bytes);
      if (chunk.eof) break;
    }
    /* oxlint-enable eslint/no-await-in-loop */
  } finally {
    await connection
      .send("IO.close", { handle: stream }, sessionId)
      .catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

function header(
  headers: readonly { readonly name: string; readonly value: string }[],
  name: string
) {
  return headers.find((entry) => entry.name.toLowerCase() === name)?.value;
}

function pdfContent(content: Buffer) {
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
