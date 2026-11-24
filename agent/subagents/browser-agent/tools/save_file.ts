import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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
  linkAddressHeld,
  withBrowserLoopSessionLock,
} from "@agent/subagents/browser-agent/lib/semantic-loop";
import { trackToolTab } from "@agent/subagents/browser-agent/lib/tool-tabs";
import {
  amazonPolicyRefusal,
  isInsideFence,
  siteNavigationFence,
} from "@agent/subagents/browser-agent/lib/policy/hosts";
import { isAmazonHost, stripeInvoiceHosts } from "@shared/browser/hosts";
import { assertWorkerNotBlocked } from "@agent/subagents/browser-agent/lib/policy/page-check";
import { siteLoginOfSession, siteOfSession } from "@agent/lib/site-principal";

const maxFileBytes = 20 * 1024 * 1024;
const readChunkBytes = 1024 * 1024;
const maxFilenameLength = 200;
const maxRedirects = 5;
const downloadTimeoutMs = 60_000;
const closeAttempts = 4;
const closeRetryMs = 250;
const closeCommandTimeoutMs = 3000;
const closeBudgetMs = 15_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const pdfSignature = Buffer.from("%PDF-", "latin1");

const notPinnedMessage =
  "Only a site task pinned to a saved login can save files.";
const notHttpsMessage =
  "save_file saves only an https address. Pass the ref of the PDF's link, such as the invoice's Download PDF link, from browser_snapshot or browser_find; never type, guess or build an address.";
const oneTargetMessage =
  "Pass save_file either the ref of the PDF's link, from browser_snapshot or browser_find, or a url the browser showed, not both.";
const staleRefMessage =
  "That ref no longer names the element it was taken from, because the page has changed since, so nothing was saved. Take a fresh browser_snapshot or browser_find and pass the link's new ref.";
const unknownTabMessage =
  "That tab is not open in the browser, so nothing was saved. Pass the ref without a tabId: a ref is read in the tab it came from.";
const noAddressMessage =
  'That element is not a link with an address, so nothing was saved. Pass the ref of the PDF\'s own link. When the PDF opens only through a button that runs a script or sends a form, delete the browser and return status "failure" saying the document exists but its PDF has no address to save.';
const offSiteMessage = `This file is not on the pinned login's site, on another host this task may open, or on Stripe's invoice pages (${stripeInvoiceHosts.join(", ")}), so it was not fetched. Do not try another route to it. Delete the browser, then return status "failure" saying the invoice file is on a website this task may not open, so the task ends as off_site.`;
const closedMessage =
  'This site task has passed its 45 minutes, so it can save no more files. Delete the browser, then return status "failure" saying the task ran out of time.';
const fullMessage =
  "This task already keeps 10 files, the most it may save, so this one was not saved. Finish with the files saved so far.";
const notPdfMessage =
  "The URL did not return a PDF, so nothing was saved. It may be a web page: open it in the browser, find its Download PDF link, and pass that link's ref.";
const linkNotPdfMessage =
  "That link opens a web page, not a PDF, so nothing was saved. Open the page by clicking the link with browser_act, take a fresh browser_snapshot there, and pass the ref of the PDF's own link.";
const linkNotHttpsMessage =
  "That link's address is not https, so the file cannot be saved. Do not try another address for it: delete the browser and return status \"failure\" saying the PDF's link is not secure.";
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
  ref: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "The element ref of the PDF's link, such as e12, from browser_snapshot or browser_find."
    ),
  tabId: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Rarely needed: a ref is read in the tab it came from. Names a tab_id to read the ref in."
    ),
  url: z
    .string()
    .trim()
    .min(1)
    .max(8000)
    .optional()
    .describe(
      "Only instead of ref, and only an address the browser showed, such as a tab's."
    ),
});

const outputSchema = z.object({
  alreadySaved: z.boolean(),
  byteSize: z.number().int(),
  fileId: z.string(),
  filename: z.string(),
});

const saveFile = defineTool({
  description: `In a site task pinned to a saved login, save one PDF, such as an invoice or a receipt, for the site to collect. Pass the browser that is signed in, the ref of the PDF's link from browser_snapshot or browser_find (such as the invoice's Download PDF link), and optionally a file name. save_file reads the link's address in the browser itself, in the tab the ref came from: never type, guess or build an address, and pass url instead of ref only for an address the browser showed, such as a tab's. Do not click a PDF's link to download it, which saves nothing; clicking a link that opens a page, such as Stripe's hosted invoice page, is fine. The file is fetched through that browser, with its sign-in. The address must be on the login's site, on another host the task may open, or on one of Stripe's invoice hosts: ${stripeInvoiceHosts.join(", ")}. Only a PDF of at most 20 MB is kept, at most 10 per task, and the same file is kept once. Returns only the saved file's id, name and size.`,
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
    const fence = siteNavigationFence(login.origin, login.alsoHosts);

    try {
      const target = targetOf(input, fence);
      const room = await siteTaskFileRoom(site, scope, taskSessionId);
      if (room !== "open") {
        throw new SaveRefusal(room === "full" ? fullMessage : closedMessage);
      }
      // No Browser Loop action, whose tab lists would show the download's
      // tab, runs while that tab is open, nor between reading a ref's address
      // and fetching it.
      const fetched = await withBrowserLoopSessionLock(
        input.browserSessionId,
        async () => {
          const url =
            target instanceof URL
              ? target
              : await linkUrl(
                  input.browserSessionId,
                  target,
                  input.tabId,
                  fence,
                  context.abortSignal
                );
          return downloadFile(
            input.browserSessionId,
            url,
            fence,
            context.abortSignal
          );
        }
      );
      const content = pdfContent(
        fetched.content,
        target instanceof URL ? notPdfMessage : linkNotPdfMessage
      );
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

// A url is checked at once; a ref is read in the browser under its lock.
function targetOf(input: { ref?: string; url?: string }, fence: SiteFence) {
  if (input.url !== undefined && input.ref === undefined) {
    return fileUrl(input.url, fence);
  }
  if (input.ref !== undefined && input.url === undefined) return input.ref;
  throw new SaveRefusal(oneTargetMessage);
}

const staleRefError = /^ref \S+ is stale or not on the current page\./u;
const unknownTabError = /^unknown tab_id /u;

// The address of the link a ref names, read in the browser, never typed by
// the model. A ref whose element is gone is refused, never matched to another.
async function linkUrl(
  sessionId: string,
  ref: string,
  tabId: string | undefined,
  fence: SiteFence,
  stopped: AbortSignal
) {
  let address: string | null;
  try {
    address = await linkAddressHeld(sessionId, ref, tabId, stopped);
  } catch (error) {
    if (error instanceof Error && staleRefError.test(error.message)) {
      throw new SaveRefusal(staleRefMessage);
    }
    if (error instanceof Error && unknownTabError.test(error.message)) {
      throw new SaveRefusal(unknownTabMessage);
    }
    throw error;
  }
  if (address === null || !/^https?:/iu.test(address)) {
    throw new SaveRefusal(noAddressMessage);
  }
  if (!/^https:/iu.test(address)) throw new SaveRefusal(linkNotHttpsMessage);
  return fileUrl(address, fence);
}

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
const targetListSchema = z.object({
  targetInfos: z.array(z.object({ targetId: z.string() })),
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
  const deadlineAt = Date.now() + downloadTimeoutMs;
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
    const forgetTab = trackToolTab(targetId);
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
        stopped,
        deadlineAt
      );
    } finally {
      if (await closeTab(browser.cdp_ws_url, connection, targetId)) {
        forgetTab();
      } else {
        console.warn("[site] download tab could not be closed");
      }
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

// The tab is closed whatever happens: a leftover tab would be the newest
// page, which other tools take for the worker's own. Chrome may drop a close
// that arrives as a document commits, and a connection that dropped takes the
// close with it, so the close is sent again, over a new connection once the
// first one fails, until the browser no longer lists the tab.
async function closeTab(
  cdpUrl: string,
  connection: CdpConnection,
  targetId: string
) {
  const budget = AbortSignal.timeout(closeBudgetMs);
  let current: CdpConnection | undefined = connection;
  let replacement: CdpConnection | undefined;
  try {
    /* oxlint-disable eslint/no-await-in-loop -- Each close is checked before the next one is sent. */
    for (
      let attempt = 0;
      attempt < closeAttempts && !budget.aborted;
      attempt += 1
    ) {
      if (attempt > 0) await sleep(closeRetryMs);
      try {
        if (!current?.isOpen) {
          replacement?.close();
          replacement = await CdpConnection.connect(cdpUrl, budget);
          current = replacement;
        }
        // A tab that is already gone has no target left to close.
        await current
          .send(
            "Target.closeTarget",
            { targetId },
            undefined,
            closeCommandTimeoutMs
          )
          .catch(() => undefined);
        const { targetInfos } = targetListSchema.parse(
          await current.send(
            "Target.getTargets",
            undefined,
            undefined,
            closeCommandTimeoutMs
          )
        );
        if (!targetInfos.some((target) => target.targetId === targetId)) {
          return true;
        }
      } catch {
        // The connection did not answer, so the next attempt opens another.
        current?.close();
        current = undefined;
      }
    }
    /* oxlint-enable eslint/no-await-in-loop */
    return false;
  } finally {
    replacement?.close();
  }
}

async function interceptedDownload(
  connection: CdpConnection,
  sessionId: string,
  url: URL,
  fence: SiteFence,
  stopped: AbortSignal,
  deadlineAt: number
) {
  // The requests paused here that are not yet let go, failed or being read.
  const held = new Set<string>();
  try {
    return await new Promise<DownloadedFile>((resolve, reject) => {
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
      // A refusal already decided stays the outcome, even when the
      // connection drops before the request could be failed.
      const fail = (error: Error) => {
        settle(() => {
          reject(refused ?? error);
        });
      };
      const onStopped = () => {
        fail(new Error("The download was stopped."));
      };

      // A refused request is failed before the refusal settles, so it is
      // never sent while the connection lives. Chrome lets a held request go
      // when the connection drops; its URL policy is then the only guard.
      const refuse = async (requestId: string, refusal: SaveRefusal) => {
        refused = refusal;
        held.delete(requestId);
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
        held.delete(requestId);
        await connection.send(
          "Fetch.continueRequest",
          { requestId },
          sessionId
        );
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
            `The file's URL answered HTTP ${String(status)}, so nothing was saved. The link may have expired: open the page that links to the file again, take a fresh browser_snapshot, and pass the link's new ref. Never guess or build an address.`
          );
        }
        const answeredUrl = fileUrl(paused.request.url, fence);
        const declaredLength = Number(header(headers, "content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maxFileBytes) {
          throw new SaveRefusal(tooLargeMessage);
        }
        // Once its body is taken, the answer goes with the tab.
        held.delete(requestId);
        const content = await readBody(
          connection,
          sessionId,
          requestId,
          stopped,
          deadlineAt
        );
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
        held.add(paused.data.requestId);
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
      // Chrome's URL policy blocked a hop, or the request failed. A service
      // worker would answer the navigation itself, out of the Fetch domain's
      // sight, so the tab's requests skip any worker and go to the network,
      // where each one is held first.
      const navigate = async () => {
        let navigated: Awaited<ReturnType<typeof connection.send>>;
        try {
          await connection.send("Network.enable", undefined, sessionId);
          await connection.send(
            "Network.setBypassServiceWorker",
            { bypass: true },
            sessionId
          );
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
  } finally {
    // A request still held goes on once the tab's connection ends, so each
    // is failed before the tab is closed.
    await Promise.all(
      [...held].map((requestId) =>
        connection
          .send(
            "Fetch.failRequest",
            { errorReason: "BlockedByClient", requestId },
            sessionId
          )
          .catch(() => undefined)
      )
    );
  }
}

async function readBody(
  connection: CdpConnection,
  sessionId: string,
  requestId: string,
  stopped: AbortSignal,
  deadlineAt: number
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
      if (stopped.aborted) throw new Error("The download was stopped.");
      // A read waits for its whole chunk or the body's end, which a slow
      // answer may take longer than one command's usual wait to send, so only
      // the download's own deadline bounds it.
      const chunk = bodyChunkSchema.parse(
        await connection.send(
          "IO.read",
          { handle: stream, size: readChunkBytes },
          sessionId,
          Math.max(1, deadlineAt - Date.now())
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

function pdfContent(content: Buffer, refusal: string) {
  if (!content.subarray(0, pdfSignature.byteLength).equals(pdfSignature)) {
    throw new SaveRefusal(refusal);
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
