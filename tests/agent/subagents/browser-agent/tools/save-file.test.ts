import { createHash } from "node:crypto";
import { NotFoundError } from "@onkernel/sdk";
import type { BrowserCurlResponse } from "@onkernel/sdk/resources/browsers";
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

import saveFileTools from "@agent/subagents/browser-agent/tools/save_file";

const curl = vi.spyOn(kernel.browsers, "curl");
const owner = accessScopeForUser("better-auth:owner-1");
const origin = "https://login.vendor.example";
const fileId = "00000000-0000-4000-8000-0000000000f1";
const signedQuery = "token=signed-download-secret";
const invoiceUrl = `https://billing.vendor.example/invoices/2026-10/download?${signedQuery}`;
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
const pdfBase64 = pdf.toString("base64");
const member = {
  attributes: { workspaceId: owner.workspaceId },
  authenticator: "authjs",
  principalId: owner.userId,
  principalType: "user",
};

const offSiteMessage =
  "This file is neither on the pinned login's site nor on Stripe's invoice pages (billing.stripe.com, files.stripe.com, invoice.stripe.com, pay.stripe.com), so it was not fetched. Do not try another route to it. Delete the browser, then return status \"failure\" saying the invoice file is on a website this task may not open, so the task ends as off_site.";
const notPdfMessage =
  "The URL did not return a PDF, so nothing was saved. It may be a web page: open it in the browser, find its Download PDF link, and save that link's address.";
const tooLargeMessage =
  "The file is larger than 20 MB, the most a task may save, so it was not saved.";
const failedMessage =
  "The file could not be fetched or saved. Retry once; if it fails again, report the failure.";

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

async function save(
  input: { browserSessionId?: string; filename?: string; url?: string } = {},
  context = workerContext()
) {
  const tool = await saveFileTool();
  return outputSchema.parse(
    await tool.execute(
      { browserSessionId: "browser-1", url: invoiceUrl, ...input },
      context
    )
  );
}

async function refusal(
  input: { filename?: string; url?: string } = {},
  context = workerContext()
) {
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

function answer(
  body: string,
  status = 200,
  headers: BrowserCurlResponse["headers"] = {}
): BrowserCurlResponse {
  return { body, duration_ms: 5, headers, status };
}

const logged: string[] = [];
const consoleSpies = (["error", "info", "log", "warn"] as const).map((level) =>
  vi.spyOn(console, level)
);

beforeEach(() => {
  vi.clearAllMocks();
  resetEveState();
  logged.length = 0;
  for (const spy of consoleSpies) {
    spy.mockImplementation((...values) => {
      logged.push(JSON.stringify(values));
    });
  }
  mocks.requireWorkerScope.mockResolvedValue(owner);
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    createdAt: "2026-11-23T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-1",
  });
  mocks.siteTaskFileRoom.mockResolvedValue("open");
  mocks.purgeExpiredTaskFiles.mockResolvedValue(undefined);
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
  curl.mockResolvedValue(
    answer(pdfBase64, 200, {
      "Content-Disposition": ['attachment; filename="Invoice 2026-10.pdf"'],
      "Content-Type": ["application/pdf"],
    })
  );
});

// No log line of any test, failures included, carries the link's query or
// the file's bytes.
afterEach(() => {
  const leaked = logged.some((line) =>
    ["signed-download-secret", pdfBase64, "%PDF"].some((value) =>
      line.includes(value)
    )
  );
  if (leaked) throw new Error("A file's link or bytes reached a log line.");
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
    expect(curl).not.toHaveBeenCalled();
    expect(mocks.saveSiteTaskFile).not.toHaveBeenCalled();
  });

  it("refuses a browser the worker does not own", async () => {
    mocks.requireOwnedBrowserSession.mockRejectedValue(
      new Error("Browser session not found.")
    );

    await expect(refusal()).resolves.toBe("Browser session not found.");
    expect(curl).not.toHaveBeenCalled();
  });
});

describe("save_file", () => {
  it("fetches the PDF through the signed-in browser and returns only its id, name and size", async () => {
    const result = await save();

    expect(result).toEqual({
      alreadySaved: false,
      byteSize: pdf.byteLength,
      fileId,
      filename: "Invoice 2026-10.pdf",
    });
    expect(curl).toHaveBeenCalledExactlyOnceWith(
      "browser-1",
      {
        method: "GET",
        response_encoding: "base64",
        timeout_ms: 60_000,
        url: invoiceUrl,
      },
      expect.objectContaining({ maxRetries: 0 })
    );
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
    for (const url of [
      "https://login.vendor.example/statements/1.pdf",
      "https://vendor.example/invoice.pdf",
      "https://invoice.stripe.com/i/acct_1/live_abc/pdf?s=ap",
      "https://pay.stripe.com/invoice/acct_1/invst_abc/pdf?s=ap",
      "https://files.stripe.com/links/abc",
      "https://billing.stripe.com/invoice/abc/pdf",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each URL is saved on its own.
      await expect(save({ url })).resolves.toMatchObject({ fileId });
    }
    expect(curl).toHaveBeenCalledTimes(6);
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
    expect(curl).not.toHaveBeenCalled();
    expect(mocks.siteTaskFileRoom).not.toHaveBeenCalled();
  });

  it("takes only https URLs without user info, and keeps Amazon blocked", async () => {
    const notHttps =
      "save_file takes the absolute https URL of the PDF itself, such as the address of the invoice's Download PDF link.";
    for (const url of [
      "http://billing.vendor.example/invoice.pdf",
      "https://user:pw@billing.vendor.example/invoice.pdf",
      "/invoices/2026-10.pdf",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each URL is refused on its own.
      await expect(refusal({ url })).resolves.toBe(notHttps);
    }
    await expect(
      refusal({ url: "https://sellercentral.amazon.com/invoice.pdf" })
    ).resolves.toMatch(/^sellercentral\.amazon\.com is an Amazon site/u);
    expect(curl).not.toHaveBeenCalled();
  });

  it("follows a redirect only while it stays inside the fence", async () => {
    curl
      .mockResolvedValueOnce(
        answer("", 302, {
          Location: ["https://files.stripe.com/links/abc?sig=xyz"],
        })
      )
      .mockResolvedValueOnce(answer(pdfBase64));

    await expect(
      save({ url: "https://pay.stripe.com/invoice/acct_1/invst_2/pdf" })
    ).resolves.toMatchObject({ filename: "document.pdf" });
    expect(curl).toHaveBeenNthCalledWith(
      2,
      "browser-1",
      expect.objectContaining({
        url: "https://files.stripe.com/links/abc?sig=xyz",
      }),
      expect.anything()
    );

    curl.mockReset();
    curl
      .mockResolvedValueOnce(answer("", 302, { location: ["/archive/x.pdf"] }))
      .mockResolvedValueOnce(answer(pdfBase64));
    await expect(save()).resolves.toMatchObject({ filename: "x.pdf" });
    expect(curl).toHaveBeenLastCalledWith(
      "browser-1",
      expect.objectContaining({
        url: "https://billing.vendor.example/archive/x.pdf",
      }),
      expect.anything()
    );

    curl.mockReset();
    curl.mockResolvedValueOnce(
      answer("", 302, {
        location: ["https://attacker.example/x.pdf?signed-download-secret"],
      })
    );
    await expect(refusal()).resolves.toBe(offSiteMessage);
    expect(curl).toHaveBeenCalledOnce();

    curl.mockReset();
    curl.mockResolvedValue(
      answer("", 301, { location: ["https://vendor.example/loop.pdf"] })
    );
    await expect(refusal()).resolves.toBe(
      "The file's URL redirected too many times, so nothing was saved."
    );
    expect(curl).toHaveBeenCalledTimes(6);
    expect(mocks.saveSiteTaskFile).toHaveBeenCalledTimes(2);
  });

  it("keeps only a 200 answer whose bytes start with %PDF-", async () => {
    curl.mockResolvedValueOnce(answer(pdfBase64, 403));
    await expect(refusal()).resolves.toBe(
      "The file's URL answered HTTP 403, so nothing was saved. The link may have expired: open the page that links to the file again and save the link's current address."
    );
    for (const body of [
      Buffer.from("<!doctype html><title>Invoice</title>").toString("base64"),
      Buffer.from(" %PDF-1.7 leading space").toString("base64"),
      Buffer.from("%PDF").toString("base64"),
      "",
    ]) {
      curl.mockResolvedValueOnce(answer(body));
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each answer is refused on its own.
      await expect(refusal()).resolves.toBe(notPdfMessage);
    }
    expect(mocks.saveSiteTaskFile).not.toHaveBeenCalled();
  });

  it("keeps a file of up to 20 MB and refuses a larger one", async () => {
    const limit = 20 * 1024 * 1024;
    const largest = Buffer.alloc(limit, 0x20);
    pdf.copy(largest);
    curl.mockResolvedValueOnce(answer(largest.toString("base64")));
    await expect(save()).resolves.toMatchObject({ byteSize: limit });

    const larger = Buffer.alloc(limit + 1, 0x20);
    pdf.copy(larger);
    curl.mockResolvedValueOnce(answer(larger.toString("base64")));
    await expect(refusal()).resolves.toBe(tooLargeMessage);

    // A body far past the limit is refused before it is decoded.
    curl.mockResolvedValueOnce(answer("A".repeat(Math.ceil(limit / 3) * 8)));
    await expect(refusal()).resolves.toBe(tooLargeMessage);
    expect(mocks.saveSiteTaskFile).toHaveBeenCalledOnce();
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
    expect(curl).not.toHaveBeenCalled();

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

  it("withholds what a failed download or save says", async () => {
    curl.mockRejectedValueOnce(
      new Error(`connect failed for ${invoiceUrl} with signed-download-secret`)
    );
    await expect(refusal()).resolves.toBe(failedMessage);

    mocks.saveSiteTaskFile.mockRejectedValueOnce(
      new Error(`Failed query: insert ... params: ${pdfBase64}`)
    );
    await expect(refusal()).resolves.toBe(failedMessage);

    mocks.siteTaskFileRoom.mockRejectedValueOnce(new Error("pool timeout"));
    await expect(refusal()).resolves.toBe(failedMessage);

    curl.mockRejectedValueOnce(
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
        "content-disposition": [
          "attachment; filename*=UTF-8''Rechnung%20Oktober.pdf; filename=\"x.pdf\"",
        ],
      },
      "Rechnung Oktober.pdf",
    ],
    [
      "the response's plain name",
      {},
      { "Content-Disposition": ["inline; filename=Statement_10.pdf"] },
      "Statement_10.pdf",
    ],
    [
      "a plain name when neither the response nor the URL names the file",
      {},
      {},
      "document.pdf",
    ],
  ])("uses %s", async (_case, input, headers, filename) => {
    curl.mockResolvedValueOnce(answer(pdfBase64, 200, headers));

    await expect(save(input)).resolves.toMatchObject({ filename });
  });

  it("takes the URL's last segment only when it names a PDF", async () => {
    curl.mockResolvedValueOnce(answer(pdfBase64));
    await expect(
      save({ url: "https://billing.vendor.example/docs/INV%202026-10.PDF?x=1" })
    ).resolves.toMatchObject({ filename: "INV 2026-10.pdf" });
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
