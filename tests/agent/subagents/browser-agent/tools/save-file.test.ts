import { createHash } from "node:crypto";
import { NotFoundError } from "@onkernel/sdk";
import type { SessionAuthContext } from "eve/context";
import type * as EveTools from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import type { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import type {
  purgeExpiredTaskFiles,
  saveSiteTaskFile,
  siteTaskFileRoom,
} from "@db/services/sites";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import {
  type linkAddressHeld,
  withBrowserLoopSessionLock,
} from "@agent/subagents/browser-agent/lib/semantic-loop";
import type * as SemanticLoop from "@agent/subagents/browser-agent/lib/semantic-loop";
import { isToolTab } from "@agent/subagents/browser-agent/lib/tool-tabs";
import { sitePrincipal } from "@agent/lib/site-principal";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  dynamicContextFor,
  dynamicTool,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { resetEveState } from "@tests/helpers/eve-state";
import { toolContextFor } from "@tests/helpers/tool-context";

const mocks = vi.hoisted(() => ({
  linkAddressHeld: vi.fn<typeof linkAddressHeld>(),
  purgeExpiredTaskFiles: vi.fn<typeof purgeExpiredTaskFiles>(),
  requireOwnedBrowserSession: vi.fn<typeof requireOwnedBrowserSession>(),
  requireWorkerScope: vi.fn<typeof requireWorkerScope>(),
  saveSiteTaskFile: vi.fn<typeof saveSiteTaskFile>(),
  siteTaskFileRoom: vi.fn<typeof siteTaskFileRoom>(),
}));

vi.mock("eve/context", () => import("@tests/helpers/eve-state"));
vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);
vi.mock("@agent/subagents/browser-agent/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));
vi.mock("@agent/subagents/browser-agent/lib/owned-browser", () => ({
  requireOwnedBrowserSession: mocks.requireOwnedBrowserSession,
}));
vi.mock("@db/services/sites", () => ({
  purgeExpiredTaskFiles: mocks.purgeExpiredTaskFiles,
  saveSiteTaskFile: mocks.saveSiteTaskFile,
  siteTaskFileRoom: mocks.siteTaskFileRoom,
}));
// The browser's lock stays real; only Browser Loop's read of a ref's address
// is stubbed (it is run against a real Chrome outside this suite).
vi.mock(
  "@agent/subagents/browser-agent/lib/semantic-loop",
  async (importOriginal) => ({
    ...(await importOriginal<typeof SemanticLoop>()),
    linkAddressHeld: mocks.linkAddressHeld,
  })
);

import saveFileTools from "@agent/subagents/browser-agent/tools/save_file";

const retrieve = vi.spyOn(kernel.browsers, "retrieve");
const owner = accessScopeForUser("better-auth:owner-1");
const origin = "https://login.vendor.example";
const fileId = "00000000-0000-4000-8000-0000000000f1";
const signedQuery = "token=signed-download-secret";
const invoiceUrl = `https://billing.vendor.example/invoices/2026-10/download?${signedQuery}`;
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
const pdfBase64 = pdf.toString("base64");
const megabyte = 1024 * 1024;
const limit = 20 * megabyte;
const member = {
  attributes: { workspaceId: owner.workspaceId },
  authenticator: "authjs",
  principalId: owner.userId,
  principalType: "user",
};

const offSiteMessage =
  "This file is neither on the pinned login's site nor on Stripe's invoice pages (billing.stripe.com, files.stripe.com, invoice.stripe.com, pay.stripe.com), so it was not fetched. Do not try another route to it. Delete the browser, then return status \"failure\" saying the invoice file is on a website this task may not open, so the task ends as off_site.";
const notHttpsMessage =
  "save_file saves only an https address. Pass the ref of the PDF's link, such as the invoice's Download PDF link, from browser_snapshot or browser_find; never type, guess or build an address.";
const notPdfMessage =
  "The URL did not return a PDF, so nothing was saved. It may be a web page: open it in the browser, find its Download PDF link, and pass that link's ref.";
const oneTargetMessage =
  "Pass save_file either the ref of the PDF's link, from browser_snapshot or browser_find, or a url the browser showed, not both.";
const staleRefMessage =
  "That ref no longer names the element it was taken from, because the page has changed since, so nothing was saved. Take a fresh browser_snapshot or browser_find and pass the link's new ref.";
const linkNotPdfMessage =
  "That link opens a web page, not a PDF, so nothing was saved. Open the page by clicking the link with browser_act, take a fresh browser_snapshot there, and pass the ref of the PDF's own link.";
const linkNotHttpsMessage =
  "That link's address is not https, so the file cannot be saved. Do not try another address for it: delete the browser and return status \"failure\" saying the PDF's link is not secure.";
const unknownTabMessage =
  "That tab is not open in the browser, so nothing was saved. Pass the ref without a tabId: a ref is read in the tab it came from.";
const noAddressMessage =
  'That element is not a link with an address, so nothing was saved. Pass the ref of the PDF\'s own link. When the PDF opens only through a button that runs a script or sends a form, delete the browser and return status "failure" saying the document exists but its PDF has no address to save.';
const tooLargeMessage =
  "The file is larger than 20 MB, the most a task may save, so it was not saved.";
const redirectsMessage =
  "The file's URL redirected too many times, so nothing was saved.";
const failedMessage =
  "The file could not be fetched or saved. Retry once; if it fails again, report the failure.";

// What the fake browser answers for a URL: a file, an error page, or a
// redirect it follows on its own unless the client stops it.
interface Route {
  readonly body?: Buffer;
  readonly headers?: Readonly<Record<string, string>>;
  readonly location?: string;
  readonly status?: number;
}

const commandSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.json()).optional(),
  sessionId: z.string().optional(),
});
type Command = z.infer<typeof commandSchema>;
const jsonSchema = z.json();
type Json = z.infer<typeof jsonSchema>;
// A document request the fake browser holds, before it is sent or at its
// answer.
interface PausedRequest {
  readonly redirectedRequestId?: string;
  readonly request: { readonly url: string };
  readonly requestId: string;
  readonly resourceType: "Document";
  readonly responseHeaders?: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly responseStatusCode?: number;
}
// What the fake browser sends back: a command's answer or an event.
interface CdpMessage {
  readonly error?: { readonly message: string };
  readonly id?: number;
  readonly method?: string;
  readonly params?: PausedRequest;
  readonly result?: Json;
  readonly sessionId?: string;
}

const downloadTab = "download-tab";
const downloadSession = "download-session";

// Chromium as the download sees it over CDP: one background tab whose
// document requests pause before they are sent and again at their answer.
const chrome = {
  // Hosts Chrome's URL policy refuses to open.
  blocked: new Set<string>(),
  // How many closes Chrome answers but drops, as it may while a document
  // commits.
  closesDropped: 0,
  commands: new Array<Command>(),
  // Commands on which the connection drops once: unanswered, then closed.
  dropOn: new Set<string>(),
  // Commands written to a socket that had already closed.
  dropped: new Array<string>(),
  failing: new Map<string, string>(),
  mostOpenTabs: 0,
  openTabs: 0,
  // How long each read of the body waits for its data.
  readDelayMs: 0,
  routes: new Map<string, Route>(),
  // Every request that left the browser, in order.
  sent: new Array<string>(),
  // Whether the tab was kept from the tools that act on the worker's page
  // while it navigated.
  hiddenWhileOpen: false,
  // The site's service worker answers navigations in its scope unless the
  // tab bypasses it, which takes the Network domain first.
  serviceWorker: false,
  tabId: downloadTab,
};

class ChromeSocket extends EventTarget {
  #bypassesWorker = false;
  #closed = false;
  #navigation: number | undefined;
  #networkEnabled = false;
  #nextRequest = 1;
  readonly #requests = new Map<
    string,
    { readonly stage: "request" | "response"; readonly url: string }
  >();
  #stream: { body: Buffer; offset: number } | undefined;

  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  // A closed socket drops what is sent on it, without an error.
  close() {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }

  send(data: string) {
    const command = commandSchema.parse(JSON.parse(data));
    if (this.#closed) {
      chrome.dropped.push(command.method);
      return;
    }
    chrome.commands.push(command);
    if (chrome.dropOn.delete(command.method)) {
      this.close();
      return;
    }
    const failure = chrome.failing.get(command.method);
    if (failure !== undefined) {
      this.#message({ error: { message: failure }, id: command.id });
      return;
    }
    const text = (name: string) => z.string().parse(command.params?.[name]);
    switch (command.method) {
      case "Target.createTarget":
        chrome.openTabs += 1;
        chrome.mostOpenTabs = Math.max(chrome.mostOpenTabs, chrome.openTabs);
        this.#reply(command, { targetId: chrome.tabId });
        return;
      case "Target.attachToTarget":
        this.#reply(command, { sessionId: downloadSession });
        return;
      case "Target.getTargets":
        this.#reply(command, {
          targetInfos: [
            { targetId: "worker-tab", type: "page", url: `${origin}/billing` },
            ...(chrome.openTabs > 0
              ? [{ targetId: chrome.tabId, type: "page", url: "about:blank" }]
              : []),
          ],
        });
        return;
      case "Network.enable":
        this.#networkEnabled = true;
        this.#reply(command, {});
        return;
      case "Network.setBypassServiceWorker":
        this.#bypassesWorker =
          this.#networkEnabled && command.params?.bypass === true;
        this.#reply(command, {});
        return;
      case "Page.navigate":
        chrome.hiddenWhileOpen = isToolTab(chrome.tabId);
        if (chrome.serviceWorker && !this.#bypassesWorker) {
          // The worker answers, the document commits, and no request pauses.
          this.#reply(command, { frameId: "frame-1", loaderId: "loader-1" });
          return;
        }
        this.#navigation = command.id;
        this.#request(text("url"));
        return;
      case "Fetch.continueRequest":
        this.#reply(command, {});
        this.#continue(text("requestId"));
        return;
      case "Fetch.failRequest":
        this.#reply(command, {});
        this.#endNavigation("net::ERR_BLOCKED_BY_CLIENT");
        return;
      case "Fetch.takeResponseBodyAsStream": {
        const request = this.#requests.get(text("requestId"));
        this.#stream = {
          body: chrome.routes.get(request?.url ?? "")?.body ?? Buffer.alloc(0),
          offset: 0,
        };
        this.#reply(command, { stream: "stream-1" });
        return;
      }
      case "IO.read": {
        const stream = this.#stream ?? { body: Buffer.alloc(0), offset: 0 };
        const size = z.number().parse(command.params?.size);
        const chunk = stream.body.subarray(stream.offset, stream.offset + size);
        stream.offset += chunk.byteLength;
        const answer = () => {
          this.#reply(command, {
            base64Encoded: true,
            data: chunk.toString("base64"),
            eof: stream.offset >= stream.body.byteLength,
          });
        };
        if (chrome.readDelayMs > 0) setTimeout(answer, chrome.readDelayMs);
        else answer();
        return;
      }
      case "Target.closeTarget":
        if (text("targetId") !== chrome.tabId || chrome.openTabs === 0) {
          this.#message({
            error: { message: "No target with given id found" },
            id: command.id,
          });
          return;
        }
        this.#reply(command, { success: true });
        if (chrome.closesDropped > 0) {
          chrome.closesDropped -= 1;
          return;
        }
        chrome.openTabs -= 1;
        this.#endNavigation("net::ERR_ABORTED");
        return;
      default:
        this.#reply(command, {});
    }
  }

  #request(url: string, redirectedRequestId?: string) {
    if (chrome.blocked.has(new URL(url).hostname)) {
      this.#endNavigation("net::ERR_BLOCKED_BY_ADMINISTRATOR");
      return;
    }
    const requestId = `request-${String(this.#nextRequest++)}`;
    this.#requests.set(requestId, { stage: "request", url });
    const paused = {
      request: { url },
      requestId,
      resourceType: "Document",
    } as const;
    this.#event(
      redirectedRequestId === undefined
        ? paused
        : { ...paused, redirectedRequestId }
    );
  }

  #continue(requestId: string) {
    const request = this.#requests.get(requestId);
    if (!request) return;
    const route = chrome.routes.get(request.url) ?? { status: 404 };
    if (request.stage === "response") {
      this.#request(new URL(route.location ?? "", request.url).href, requestId);
      return;
    }
    chrome.sent.push(request.url);
    this.#requests.set(requestId, { stage: "response", url: request.url });
    const headers = Object.entries(route.headers ?? {}).map(
      ([name, value]) => ({ name, value })
    );
    if (route.location !== undefined) {
      headers.push({ name: "Location", value: route.location });
    }
    this.#event({
      request: { url: request.url },
      requestId,
      resourceType: "Document",
      responseHeaders: headers,
      responseStatusCode:
        route.status ?? (route.location === undefined ? 200 : 302),
    });
  }

  #endNavigation(errorText: string) {
    const id = this.#navigation;
    this.#navigation = undefined;
    if (id !== undefined) this.#message({ id, result: { errorText } });
  }

  #reply(command: Command, result: Json) {
    this.#message({ id: command.id, result });
  }

  #event(params: PausedRequest) {
    this.#message({
      method: "Fetch.requestPaused",
      params,
      sessionId: downloadSession,
    });
  }

  #message(message: CdpMessage) {
    queueMicrotask(() => {
      if (this.#closed) return;
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(message) })
      );
    });
  }
}

function serve(url: string, route: Route = {}) {
  chrome.routes.set(url, { body: pdf, ...route });
}

function sentCommands(method: string) {
  return chrome.commands.filter((command) => command.method === method);
}

function pinned(login = { id: "login-1", origin }) {
  return sitePrincipal(
    { login, op: "create", site: "teemiq" },
    "owner@example.test",
    owner
  );
}

function unpinned() {
  return sitePrincipal(
    { op: "create", site: "teemiq" },
    "owner@example.test",
    owner
  );
}

// A worker the site task's root session delegated; a later turn the owner
// sends keeps the initiator's pin.
function workerContext(
  initiator: SessionAuthContext = pinned(),
  current: SessionAuthContext = initiator
) {
  return toolContextFor({
    auth: { current, initiator },
    parentSessionId: "wrun_root",
    sessionId: "worker-1",
  });
}

async function saveFileTool(initiator: SessionAuthContext = pinned()) {
  const resolved = await evaluateDynamic(
    saveFileTools,
    dynamicContextFor({ auth: { current: initiator, initiator } })
  );
  return dynamicTool(resolved, "save_file");
}

const outputSchema = z.strictObject({
  alreadySaved: z.boolean(),
  byteSize: z.number(),
  fileId: z.string(),
  filename: z.string(),
});

interface SaveInput {
  browserSessionId?: string;
  filename?: string;
  ref?: string;
  tabId?: string;
  url?: string;
}

async function save(input: SaveInput = {}, context = workerContext()) {
  const tool = await saveFileTool();
  return outputSchema.parse(
    await tool.execute(
      { browserSessionId: "browser-1", url: invoiceUrl, ...input },
      context
    )
  );
}

async function refusal(input: SaveInput = {}, context = workerContext()) {
  const tool = await saveFileTool();
  try {
    await tool.execute(
      { browserSessionId: "browser-1", url: invoiceUrl, ...input },
      context
    );
  } catch (error) {
    return error instanceof Error ? error.message : "not an error";
  }
  throw new Error("save_file did not refuse.");
}

const logged: string[] = [];
const consoleSpies = (["error", "info", "log", "warn"] as const).map((level) =>
  vi.spyOn(console, level)
);

beforeEach(() => {
  vi.clearAllMocks();
  resetEveState();
  vi.stubGlobal("WebSocket", ChromeSocket);
  chrome.blocked.clear();
  chrome.closesDropped = 0;
  chrome.commands.length = 0;
  chrome.dropOn.clear();
  chrome.dropped.length = 0;
  chrome.failing.clear();
  chrome.hiddenWhileOpen = false;
  chrome.mostOpenTabs = 0;
  chrome.openTabs = 0;
  chrome.readDelayMs = 0;
  chrome.routes.clear();
  chrome.sent.length = 0;
  chrome.serviceWorker = false;
  chrome.tabId = downloadTab;
  logged.length = 0;
  for (const spy of consoleSpies) {
    spy.mockImplementation((...values) => {
      logged.push(JSON.stringify(values));
    });
  }
  retrieve.mockResolvedValue({
    browser_live_view_url: "https://live.kernel.test/browser-1",
    cdp_ws_url: "wss://kernel.test/cdp",
    created_at: "2026-11-23T00:00:00.000Z",
    headless: false,
    memory: "2GiB",
    profile_save_changes: false,
    region: "us-east",
    session_id: "browser-1",
    stealth: false,
    timeout_seconds: 1800,
    webdriver_ws_url: "wss://kernel.test/webdriver",
  });
  mocks.requireWorkerScope.mockResolvedValue(owner);
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    createdAt: "2026-11-23T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-1",
  });
  mocks.siteTaskFileRoom.mockResolvedValue("open");
  mocks.purgeExpiredTaskFiles.mockResolvedValue(0);
  mocks.saveSiteTaskFile.mockImplementation(
    async (_site, _scope, _s, file) => ({
      alreadySaved: false,
      file: {
        byteSize: file.content.byteLength,
        fileId,
        filename: file.filename,
      },
      ok: true,
    })
  );
  serve(invoiceUrl, {
    headers: {
      "Content-Disposition": 'attachment; filename="Invoice 2026-10.pdf"',
      "Content-Type": "application/pdf",
    },
  });
});

// No log line of any test, failures included, carries the link's query or
// the file's bytes, and no download leaves its tab open.
afterEach(() => {
  vi.unstubAllGlobals();
  const leaked = logged.some((line) =>
    ["signed-download-secret", pdfBase64, "%PDF"].some((value) =>
      line.includes(value)
    )
  );
  if (leaked) throw new Error("A file's link or bytes reached a log line.");
  if (chrome.openTabs !== 0) throw new Error("A download left its tab open.");
  if (chrome.dropped.length > 0) {
    throw new Error("A command was written to a closed connection.");
  }
});

async function offered(
  initiator: SessionAuthContext | null,
  current: SessionAuthContext | null = initiator
) {
  return evaluateDynamic(
    saveFileTools,
    dynamicContextFor({ auth: { current, initiator } })
  );
}

describe("save_file availability", () => {
  it("is offered only to a site task pinned to a saved login", async () => {
    const scheduled = {
      attributes: { workspaceId: owner.workspaceId },
      authenticator: "scheduled-worker",
      principalId: owner.userId,
      principalType: "user",
    };

    expect(Object.keys((await offered(pinned())) ?? {})).toEqual(["save_file"]);
    // The owner writing into the task later keeps the pin.
    expect(Object.keys((await offered(pinned(), member)) ?? {})).toEqual([
      "save_file",
    ]);
    expect(await offered(unpinned())).toBeNull();
    expect(await offered(member)).toBeNull();
    expect(await offered(scheduled)).toBeNull();
    expect(await offered(null, member)).toBeNull();
  });

  it("refuses a worker whose session is not pinned, before any download", async () => {
    await expect(
      refusal({}, workerContext(unpinned(), unpinned()))
    ).resolves.toBe("Only a site task pinned to a saved login can save files.");
    await expect(refusal({}, workerContext(member, member))).resolves.toBe(
      "Only a site task pinned to a saved login can save files."
    );
    expect(retrieve).not.toHaveBeenCalled();
    expect(mocks.saveSiteTaskFile).not.toHaveBeenCalled();
  });

  it("refuses a browser the worker does not own", async () => {
    mocks.requireOwnedBrowserSession.mockRejectedValue(
      new Error("Browser session not found.")
    );

    await expect(refusal()).resolves.toBe("Browser session not found.");
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe("save_file", () => {
  it("opens the PDF in a background tab of the signed-in browser and returns only its id, name and size", async () => {
    const result = await save();

    expect(result).toEqual({
      alreadySaved: false,
      byteSize: pdf.byteLength,
      fileId,
      filename: "Invoice 2026-10.pdf",
    });
    expect(retrieve).toHaveBeenCalledOnce();
    const [browserId, query, options] = retrieve.mock.calls[0] ?? [];
    expect([browserId, query]).toEqual(["browser-1", {}]);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(chrome.commands.map(({ method }) => method)).toEqual([
      "Target.createTarget",
      "Target.attachToTarget",
      "Network.enable",
      "Network.setBypassServiceWorker",
      "Fetch.enable",
      "Page.navigate",
      "Fetch.continueRequest",
      "Fetch.takeResponseBodyAsStream",
      "IO.read",
      "IO.close",
      "Target.closeTarget",
      "Target.getTargets",
    ]);
    expect(sentCommands("Target.createTarget")[0]?.params).toEqual({
      background: true,
      url: "about:blank",
    });
    // Only the download's own tab pauses its requests.
    expect(sentCommands("Fetch.enable")).toEqual([
      expect.objectContaining({
        params: {
          patterns: [
            {
              requestStage: "Request",
              resourceType: "Document",
              urlPattern: "*",
            },
            {
              requestStage: "Response",
              resourceType: "Document",
              urlPattern: "*",
            },
          ],
        },
        sessionId: downloadSession,
      }),
    ]);
    // A service worker never answers for the network.
    expect(sentCommands("Network.setBypassServiceWorker")).toEqual([
      expect.objectContaining({
        params: { bypass: true },
        sessionId: downloadSession,
      }),
    ]);
    expect(sentCommands("Page.navigate")[0]).toMatchObject({
      params: { url: invoiceUrl },
      sessionId: downloadSession,
    });
    expect(sentCommands("Target.closeTarget")[0]?.params).toEqual({
      targetId: downloadTab,
    });
    expect(chrome.sent).toEqual([invoiceUrl]);
    expect(mocks.siteTaskFileRoom).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      "wrun_root"
    );
    expect(mocks.purgeExpiredTaskFiles).toHaveBeenCalledOnce();
    expect(mocks.saveSiteTaskFile).toHaveBeenCalledExactlyOnceWith(
      "teemiq",
      owner,
      "wrun_root",
      {
        content: pdf,
        filename: "Invoice 2026-10.pdf",
        sha256: createHash("sha256").update(pdf).digest("hex"),
      }
    );
    const shown = JSON.stringify(result);
    expect(shown).not.toContain("signed-download-secret");
    expect(shown).not.toContain(pdfBase64);
    expect(shown).not.toContain("%PDF");
  });

  it("saves from the login's site, any host under its domain, and Stripe's invoice hosts", async () => {
    const urls = [
      "https://login.vendor.example/statements/1.pdf",
      "https://vendor.example/invoice.pdf",
      "https://invoice.stripe.com/i/acct_1/live_abc/pdf?s=ap",
      "https://pay.stripe.com/invoice/acct_1/invst_abc/pdf?s=ap",
      "https://files.stripe.com/links/abc",
      "https://billing.stripe.com/invoice/abc/pdf",
    ];
    for (const url of urls) {
      serve(url);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each URL is saved on its own.
      await expect(save({ url })).resolves.toMatchObject({ fileId });
    }
    expect(chrome.sent).toEqual(urls);
  });

  it("refuses any other host with a fixed message that ends the task as off_site", async () => {
    for (const url of [
      "https://attacker.example/invoice.pdf?leak=signed-download-secret",
      "https://dashboard.stripe.com/invoices/in_1/pdf",
      "https://evil.invoice.stripe.com/x.pdf",
      "https://vendor.example.evil.test/x.pdf",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each URL is refused on its own.
      const message = await refusal({ url });
      expect(message).toBe(offSiteMessage);
      expect(message).not.toContain(new URL(url).hostname);
    }
    expect(retrieve).not.toHaveBeenCalled();
    expect(chrome.commands).toEqual([]);
    expect(mocks.siteTaskFileRoom).not.toHaveBeenCalled();
  });

  it("takes only https URLs without user info, and keeps Amazon blocked", async () => {
    for (const url of [
      "http://billing.vendor.example/invoice.pdf",
      "https://user:pw@billing.vendor.example/invoice.pdf",
      "/invoices/2026-10.pdf",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each URL is refused on its own.
      await expect(refusal({ url })).resolves.toBe(notHttpsMessage);
    }
    await expect(
      refusal({ url: "https://sellercentral.amazon.com/invoice.pdf" })
    ).resolves.toMatch(/^sellercentral\.amazon\.com is an Amazon site/u);
    expect(chrome.commands).toEqual([]);
  });
});

function byRef(ref: string, more: SaveInput = {}): SaveInput {
  return { ref, url: undefined, ...more };
}

describe("save_file refs", () => {
  const goneMessage =
    'The browser closed before the file was fetched. Return status "failure" saying the browser expired before the file was saved.';

  it("reads the address of the link a ref names in the browser, in the same hold of its lock as the download", async () => {
    const order: string[] = [];
    mocks.linkAddressHeld.mockImplementation(async () => {
      order.push("read");
      // A browser action asked for now waits until the download is done.
      void withBrowserLoopSessionLock("browser-1", async () => {
        order.push(`action after ${String(chrome.commands.length)} commands`);
      });
      return invoiceUrl;
    });

    const result = await save(byRef("e12"));

    expect(result).toEqual({
      alreadySaved: false,
      byteSize: pdf.byteLength,
      fileId,
      filename: "Invoice 2026-10.pdf",
    });
    expect(mocks.linkAddressHeld).toHaveBeenCalledExactlyOnceWith(
      "browser-1",
      "e12",
      undefined,
      expect.any(AbortSignal)
    );
    expect(chrome.sent).toEqual([invoiceUrl]);
    await vi.waitFor(() => {
      expect(order).toHaveLength(2);
    });
    expect(order).toEqual([
      "read",
      `action after ${String(chrome.commands.length)} commands`,
    ]);
    expect(JSON.stringify(result)).not.toContain("signed-download-secret");
  });

  it("passes the ref's tab on", async () => {
    mocks.linkAddressHeld.mockResolvedValue(invoiceUrl);

    await save(byRef("e3", { tabId: "A1B2" }));

    expect(mocks.linkAddressHeld).toHaveBeenCalledExactlyOnceWith(
      "browser-1",
      "e3",
      "A1B2",
      expect.any(AbortSignal)
    );
  });

  it("holds a ref's address to the same fence as a url, and sends nothing outside it", async () => {
    mocks.linkAddressHeld.mockResolvedValue(
      "https://attacker.example/invoice.pdf?leak=signed-download-secret"
    );
    await expect(refusal(byRef("e4"))).resolves.toBe(offSiteMessage);
    mocks.linkAddressHeld.mockResolvedValue(
      "http://billing.vendor.example/invoice.pdf"
    );
    await expect(refusal(byRef("e4"))).resolves.toBe(linkNotHttpsMessage);
    mocks.linkAddressHeld.mockResolvedValue(
      "https://sellercentral.amazon.com/invoice.pdf"
    );
    await expect(refusal(byRef("e4"))).resolves.toMatch(
      /^sellercentral\.amazon\.com is an Amazon site/u
    );
    expect(retrieve).not.toHaveBeenCalled();
    expect(chrome.commands).toEqual([]);
  });

  it("refuses an element that is not a link with an address", async () => {
    for (const address of [
      null,
      "javascript:void(0)",
      "blob:https://login.vendor.example/1",
      "about:blank",
    ]) {
      mocks.linkAddressHeld.mockResolvedValue(address);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each element is refused on its own.
      await expect(refusal(byRef("e5"))).resolves.toBe(noAddressMessage);
    }
    expect(chrome.commands).toEqual([]);
  });

  it("refuses a stale ref or a closed tab with what to do next, and withholds anything else", async () => {
    mocks.linkAddressHeld.mockRejectedValueOnce(
      new Error(
        "ref e9 is stale or not on the current page. Call snapshot (or find) to get fresh element references."
      )
    );
    await expect(refusal(byRef("e9"))).resolves.toBe(staleRefMessage);

    mocks.linkAddressHeld.mockRejectedValueOnce(
      new Error('unknown tab_id "ZZ". Call list_tabs for current tabs.')
    );
    await expect(refusal(byRef("e9", { tabId: "ZZ" }))).resolves.toBe(
      unknownTabMessage
    );
    expect(logged).toEqual([]);

    mocks.linkAddressHeld.mockRejectedValueOnce(
      new Error(`CDP failed on ${invoiceUrl}`)
    );
    await expect(refusal(byRef("e9"))).resolves.toBe(failedMessage);
    expect(logged).toEqual([
      JSON.stringify([
        "[site] task file not saved",
        { error: "Error", site: "teemiq" },
      ]),
    ]);

    mocks.linkAddressHeld.mockRejectedValueOnce(
      new NotFoundError(404, { error: "gone" }, "browser", new Headers())
    );
    await expect(refusal(byRef("e9"))).resolves.toBe(goneMessage);
    expect(chrome.commands).toEqual([]);
  });

  it("tells the worker to open a link that leads to a web page and save the PDF there", async () => {
    const hosted = "https://pay.stripe.com/invoice/acct_1/invst_9";
    serve(hosted, {
      body: Buffer.from("<html>Invoice</html>"),
      headers: { "Content-Type": "text/html" },
    });
    mocks.linkAddressHeld.mockResolvedValue(hosted);

    await expect(refusal(byRef("e7"))).resolves.toBe(linkNotPdfMessage);
    // A url the worker passed keeps the url's wording.
    await expect(refusal({ url: hosted })).resolves.toBe(notPdfMessage);
    expect(mocks.saveSiteTaskFile).not.toHaveBeenCalled();
  });

  it("checks the task's room before reading a ref", async () => {
    mocks.siteTaskFileRoom.mockResolvedValue("full");

    await expect(refusal(byRef("e6"))).resolves.toBe(
      "This task already keeps 10 files, the most it may save, so this one was not saved. Finish with the files saved so far."
    );
    expect(mocks.linkAddressHeld).not.toHaveBeenCalled();
  });

  it("takes either a ref or a url, not both and not neither", async () => {
    await expect(refusal({ ref: "e1" })).resolves.toBe(oneTargetMessage);
    await expect(refusal({ url: undefined })).resolves.toBe(oneTargetMessage);
    expect(mocks.linkAddressHeld).not.toHaveBeenCalled();
    expect(mocks.siteTaskFileRoom).not.toHaveBeenCalled();
    expect(chrome.commands).toEqual([]);
  });
});

describe("save_file redirects", () => {
  const stripeInvoice = "https://pay.stripe.com/invoice/acct_1/invst_2/pdf";

  it("follows a redirect that stays inside the fence, checking each hop before it is sent", async () => {
    const signed = "https://files.stripe.com/links/abc?sig=xyz";
    serve(stripeInvoice, { location: signed });
    serve(signed);

    await expect(save({ url: stripeInvoice })).resolves.toMatchObject({
      filename: "document.pdf",
    });
    expect(chrome.sent).toEqual([stripeInvoice, signed]);

    chrome.sent.length = 0;
    serve(invoiceUrl, { location: "/archive/x.pdf", status: 301 });
    serve("https://billing.vendor.example/archive/x.pdf");
    await expect(save()).resolves.toMatchObject({ filename: "x.pdf" });
    expect(chrome.sent).toEqual([
      invoiceUrl,
      "https://billing.vendor.example/archive/x.pdf",
    ]);
  });

  it("never sends a hop that leaves the fence, reaches Amazon or drops https", async () => {
    for (const [location, message] of [
      ["https://attacker.example/x.pdf?signed-download-secret", offSiteMessage],
      ["https://dashboard.stripe.com/x.pdf", offSiteMessage],
      ["http://billing.vendor.example/x.pdf", notHttpsMessage],
      [
        "https://sellercentral.amazon.com/x.pdf",
        expect.stringMatching(/^sellercentral\.amazon\.com is an Amazon site/u),
      ],
    ] as const) {
      chrome.commands.length = 0;
      chrome.sent.length = 0;
      serve(invoiceUrl, { location });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each redirect is refused on its own.
      await expect(refusal()).resolves.toEqual(message);
      expect(chrome.sent).toEqual([invoiceUrl]);
      expect(sentCommands("Fetch.failRequest")).toEqual([
        expect.objectContaining({
          params: { errorReason: "BlockedByClient", requestId: "request-1" },
          sessionId: downloadSession,
        }),
      ]);
    }
    expect(mocks.saveSiteTaskFile).not.toHaveBeenCalled();
  });

  it("stops a redirect chain after five redirects", async () => {
    serve(invoiceUrl, { location: "https://vendor.example/loop-1.pdf" });
    for (const hop of [1, 2, 3, 4, 5]) {
      serve(`https://vendor.example/loop-${String(hop)}.pdf`, {
        location: `https://vendor.example/loop-${String(hop + 1)}.pdf`,
      });
    }

    await expect(refusal()).resolves.toBe(redirectsMessage);
    expect(chrome.sent).toHaveLength(6);
    expect(sentCommands("Fetch.failRequest")).toHaveLength(1);
  });

  it("keeps off_site when the connection drops before the refused hop is failed", async () => {
    serve(invoiceUrl, { location: "https://attacker.example/x.pdf" });
    chrome.dropOn.add("Fetch.failRequest");

    await expect(refusal()).resolves.toBe(offSiteMessage);
    expect(chrome.openTabs).toBe(0);
    expect(mocks.saveSiteTaskFile).not.toHaveBeenCalled();
  });

  it("reads off_site when Chrome's URL policy blocks a hop", async () => {
    serve(invoiceUrl, { location: "https://cdn.vendor.example/x.pdf" });
    chrome.blocked.add("cdn.vendor.example");

    await expect(refusal()).resolves.toBe(offSiteMessage);
    expect(chrome.sent).toEqual([invoiceUrl]);
  });
});

describe("save_file answers", () => {
  it("keeps only a 200 answer whose bytes start with %PDF-", async () => {
    serve(invoiceUrl, { status: 403 });
    await expect(refusal()).resolves.toBe(
      "The file's URL answered HTTP 403, so nothing was saved. The link may have expired: open the page that links to the file again, take a fresh browser_snapshot, and pass the link's new ref. Never guess or build an address."
    );
    // The held answer is failed before the tab closes, so it never shows.
    const methods = chrome.commands.map(({ method }) => method);
    expect(sentCommands("Fetch.failRequest")).toEqual([
      expect.objectContaining({
        params: { errorReason: "BlockedByClient", requestId: "request-1" },
        sessionId: downloadSession,
      }),
    ]);
    expect(methods.indexOf("Fetch.failRequest")).toBeLessThan(
      methods.indexOf("Target.closeTarget")
    );
    for (const body of [
      Buffer.from("<!doctype html><title>Invoice</title>"),
      Buffer.from(" %PDF-1.7 leading space"),
      Buffer.from("%PDF"),
      Buffer.alloc(0),
    ]) {
      serve(invoiceUrl, { body });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each answer is refused on its own.
      await expect(refusal()).resolves.toBe(notPdfMessage);
    }
    expect(mocks.saveSiteTaskFile).not.toHaveBeenCalled();
  });

  it("keeps a file of up to 20 MB and stops reading a larger one at the cap", async () => {
    const largest = Buffer.alloc(limit, 0x20);
    pdf.copy(largest);
    serve(invoiceUrl, { body: largest });
    await expect(save()).resolves.toMatchObject({ byteSize: limit });

    chrome.commands.length = 0;
    const larger = Buffer.alloc(limit + megabyte * 5, 0x20);
    pdf.copy(larger);
    serve(invoiceUrl, { body: larger });
    await expect(refusal()).resolves.toBe(tooLargeMessage);
    // Reading stops at the first megabyte past the cap.
    expect(sentCommands("IO.read")).toHaveLength(21);
    expect(sentCommands("IO.close")).toHaveLength(1);
    expect(mocks.saveSiteTaskFile).toHaveBeenCalledOnce();
  });

  it("refuses a file whose declared length passes 20 MB before reading it", async () => {
    serve(invoiceUrl, {
      headers: { "content-length": String(limit + 1) },
    });

    await expect(refusal()).resolves.toBe(tooLargeMessage);
    expect(sentCommands("Fetch.takeResponseBodyAsStream")).toEqual([]);
    expect(sentCommands("IO.read")).toEqual([]);
    expect(sentCommands("Fetch.failRequest")).toHaveLength(1);
  });

  it("waits for a slow answer until the download's own deadline, not one command's", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      chrome.readDelayMs = 20_000;
      const saving = save();
      await vi.waitFor(() => {
        expect(sentCommands("IO.read")).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(saving).resolves.toMatchObject({ fileId });

      chrome.readDelayMs = 70_000;
      const stalled = refusal();
      await vi.waitFor(() => {
        expect(sentCommands("IO.read")).toHaveLength(2);
      });
      await vi.advanceTimersByTimeAsync(61_000);
      await expect(stalled).resolves.toBe(failedMessage);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an eleventh file, and saves nothing once the task's 45 minutes have passed", async () => {
    mocks.siteTaskFileRoom.mockResolvedValueOnce("full");
    await expect(refusal()).resolves.toBe(
      "This task already keeps 10 files, the most it may save, so this one was not saved. Finish with the files saved so far."
    );
    mocks.siteTaskFileRoom.mockResolvedValueOnce("closed");
    const closed =
      'This site task has passed its 45 minutes, so it can save no more files. Delete the browser, then return status "failure" saying the task ran out of time.';
    await expect(refusal()).resolves.toBe(closed);
    expect(retrieve).not.toHaveBeenCalled();

    // Another save may take the last place while this one downloads.
    mocks.saveSiteTaskFile.mockResolvedValueOnce({ ok: false, reason: "full" });
    await expect(refusal()).resolves.toMatch(/^This task already keeps 10/u);
    mocks.saveSiteTaskFile.mockResolvedValueOnce({
      ok: false,
      reason: "closed",
    });
    await expect(refusal()).resolves.toBe(closed);
  });

  it("reports a file saved before as the same file", async () => {
    mocks.saveSiteTaskFile.mockResolvedValueOnce({
      alreadySaved: true,
      file: { byteSize: pdf.byteLength, fileId, filename: "First name.pdf" },
      ok: true,
    });

    await expect(save()).resolves.toEqual({
      alreadySaved: true,
      byteSize: pdf.byteLength,
      fileId,
      filename: "First name.pdf",
    });
  });

  it("withholds what a failed download or save says, and still closes its tab", async () => {
    chrome.failing.set(
      "IO.read",
      `read failed for ${invoiceUrl} with signed-download-secret`
    );
    await expect(refusal()).resolves.toBe(failedMessage);
    expect(sentCommands("Target.closeTarget")).toHaveLength(1);
    chrome.failing.clear();

    mocks.saveSiteTaskFile.mockRejectedValueOnce(
      new Error(`Failed query: insert ... params: ${pdfBase64}`)
    );
    await expect(refusal()).resolves.toBe(failedMessage);

    mocks.siteTaskFileRoom.mockRejectedValueOnce(new Error("pool timeout"));
    await expect(refusal()).resolves.toBe(failedMessage);

    chrome.failing.set("Target.createTarget", `no tab for ${invoiceUrl}`);
    await expect(refusal()).resolves.toBe(failedMessage);
    chrome.failing.clear();

    retrieve.mockRejectedValueOnce(
      new NotFoundError(
        404,
        { error: "gone" },
        `browser for ${invoiceUrl}`,
        new Headers()
      )
    );
    await expect(refusal()).resolves.toBe(
      'The browser closed before the file was fetched. Return status "failure" saying the browser expired before the file was saved.'
    );
    expect(logged.length).toBeGreaterThan(0);
  });

  it("gives up when the worker is stopped, closing its tab", async () => {
    const stop = new AbortController();
    const context = toolContextFor({
      abortSignal: stop.signal,
      auth: { current: pinned(), initiator: pinned() },
      parentSessionId: "wrun_root",
      sessionId: "worker-1",
    });
    stop.abort();

    await expect(refusal({}, context)).resolves.toBe(failedMessage);
    expect(sentCommands("Page.navigate")).toEqual([]);
    expect(mocks.saveSiteTaskFile).not.toHaveBeenCalled();
  });
});

describe("save_file tab", () => {
  it("goes around a service worker that answers navigations, so each hop is still held", async () => {
    chrome.serviceWorker = true;

    await expect(save()).resolves.toMatchObject({ fileId });
    // The bypass takes the Network domain, and both come before the hold.
    expect(chrome.commands.slice(2, 6).map(({ method }) => method)).toEqual([
      "Network.enable",
      "Network.setBypassServiceWorker",
      "Fetch.enable",
      "Page.navigate",
    ]);
    expect(chrome.sent).toEqual([invoiceUrl]);
  });

  it("fetches nothing when the tab cannot go around the service worker", async () => {
    chrome.serviceWorker = true;
    chrome.failing.set(
      "Network.setBypassServiceWorker",
      `no bypass for ${invoiceUrl}`
    );

    await expect(refusal()).resolves.toBe(failedMessage);
    expect(sentCommands("Fetch.enable")).toEqual([]);
    expect(sentCommands("Page.navigate")).toEqual([]);
    expect(chrome.sent).toEqual([]);
  });

  it("keeps its tab from the tools that act on the worker's page while it is open", async () => {
    await save();

    expect(chrome.hiddenWhileOpen).toBe(true);
    expect(isToolTab(downloadTab)).toBe(false);
  });

  it("closes the tab again when Chrome drops the first close", async () => {
    chrome.closesDropped = 1;

    await expect(save()).resolves.toMatchObject({ fileId });
    expect(sentCommands("Target.closeTarget")).toHaveLength(2);
    expect(chrome.openTabs).toBe(0);
    expect(isToolTab(downloadTab)).toBe(false);
  });

  it("keeps a tab it could not close hidden, and logs only that", async () => {
    chrome.tabId = "stuck-tab";
    chrome.closesDropped = 10;

    await expect(save()).resolves.toMatchObject({ fileId });
    expect(sentCommands("Target.closeTarget")).toHaveLength(4);
    expect(isToolTab("stuck-tab")).toBe(true);
    expect(logged).toEqual([
      JSON.stringify(["[site] download tab could not be closed"]),
    ]);
    chrome.openTabs = 0;
  });

  it.each(["IO.read", "Fetch.takeResponseBodyAsStream"])(
    "closes the tab over a new connection when the connection drops at %s, at once",
    async (method) => {
      chrome.dropOn.add(method);
      const started = Date.now();

      await expect(refusal()).resolves.toBe(failedMessage);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(chrome.openTabs).toBe(0);
      expect(sentCommands("Target.closeTarget")).toHaveLength(1);
    }
  );

  it("waits for a browser action on the same browser before it opens its tab", async () => {
    const running = Promise.withResolvers<undefined>();
    const action = withBrowserLoopSessionLock(
      "browser-1",
      async () => running.promise
    );
    const saving = save();
    await vi.waitFor(() => {
      expect(mocks.siteTaskFileRoom).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(chrome.commands).toEqual([]);
    running.resolve(undefined);
    await action;
    await expect(saving).resolves.toMatchObject({ fileId });
  });

  it("opens one download tab at a time in a browser", async () => {
    const other = "https://billing.vendor.example/invoices/2026-11.pdf";
    serve(other);

    await expect(Promise.all([save(), save({ url: other })])).resolves.toEqual([
      expect.objectContaining({ fileId }),
      expect.objectContaining({ fileId }),
    ]);
    expect(chrome.mostOpenTabs).toBe(1);
    expect(sentCommands("Target.createTarget")).toHaveLength(2);
  });
});

describe("save_file names", () => {
  it.each([
    [
      "the name the worker gives, cleaned",
      { filename: "../../tmp/Invoice\u0000 Oct.PDF" },
      {},
      "Invoice Oct.pdf",
    ],
    [
      "a name without an extension",
      { filename: "Receipt 2026-10" },
      {},
      "Receipt 2026-10.pdf",
    ],
    ["a hidden-file name", { filename: "...pdf" }, {}, "document.pdf"],
    [
      "a name with direction and reserved characters",
      { filename: "inv‮fdp.exe<1>.pdf" },
      {},
      "inv fdp.exe_1_.pdf",
    ],
    [
      "the response's encoded name",
      {},
      {
        "content-disposition":
          "attachment; filename*=UTF-8''Rechnung%20Oktober.pdf; filename=\"x.pdf\"",
      },
      "Rechnung Oktober.pdf",
    ],
    [
      "the response's plain name",
      {},
      { "Content-Disposition": "inline; filename=Statement_10.pdf" },
      "Statement_10.pdf",
    ],
    [
      "a plain name when neither the response nor the URL names the file",
      {},
      {},
      "document.pdf",
    ],
  ])("uses %s", async (_case, input, headers, filename) => {
    serve(invoiceUrl, { headers });

    await expect(save(input)).resolves.toMatchObject({ filename });
  });

  it("takes the URL's last segment only when it names a PDF", async () => {
    const url = "https://billing.vendor.example/docs/INV%202026-10.PDF?x=1";
    serve(url);
    await expect(save({ url })).resolves.toMatchObject({
      filename: "INV 2026-10.pdf",
    });
  });

  it("keeps a name to 200 characters, ending in .pdf", async () => {
    const result = await save({
      filename: `${"é".repeat(150)}${"😀".repeat(40)}.pdf`,
    });

    expect(result.filename.length).toBeLessThanOrEqual(200);
    expect(result.filename).toMatch(/^é{150}(?:😀)+\.pdf$/u);
    expect(result.filename).not.toMatch(/[\uD800-\uDBFF]\.pdf$/u);
  });
});
