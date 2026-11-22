import type { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface TestEnvironment {
  EVE_NEXT_PRODUCTION_PORT: number | undefined;
  NODE_ENV: "development" | "production" | "test";
  SCHEDULED_RUN_SECRET: string | undefined;
}

const secret = "scheduled-run-secret-0123456789abcdefghij";

const mocks = vi.hoisted(() => {
  const env: TestEnvironment = {
    EVE_NEXT_PRODUCTION_PORT: undefined,
    NODE_ENV: "production",
    SCHEDULED_RUN_SECRET: undefined,
  };
  return { env, readFile: vi.fn<typeof readFile>() };
});

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("@shared/environment", () => ({ env: mocks.env }));

import {
  postScheduledReport,
  postScheduledRunRoute,
} from "@agent/lib/schedules/request";

describe("scheduled run requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));
    mocks.env.EVE_NEXT_PRODUCTION_PORT = undefined;
    mocks.env.NODE_ENV = "production";
    mocks.env.SCHEDULED_RUN_SECRET = secret;
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        appRoot: process.cwd(),
        origin: "http://127.0.0.1:51829",
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only the report handler's asynchronous acknowledgment", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));
    await expect(postScheduledReport("run-1")).resolves.toBeUndefined();
  });

  it("rejects a successful HTML fallback instead of losing a scheduled report", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("<!doctype html><h1>404</h1>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );
    await expect(postScheduledReport("run-1")).rejects.toThrow(
      "Scheduled report callback failed (200)"
    );
  });

  it("posts to the co-located eve server over loopback with the shared secret", async () => {
    await postScheduledRunRoute("/internal/scheduled-run/report", {
      runId: "run-1",
    });

    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      new URL("http://127.0.0.1:4274/internal/scheduled-run/report"),
      expect.objectContaining({
        body: JSON.stringify({ runId: "run-1" }),
        method: "POST",
        redirect: "error",
      })
    );
    expect(sentHeaders().get("authorization")).toBe(`Bearer ${secret}`);
    expect(sentHeaders().get("content-type")).toBe("application/json");
  });

  it("follows a configured eve port", async () => {
    mocks.env.EVE_NEXT_PRODUCTION_PORT = 5100;

    await postScheduledRunRoute("/internal/scheduled-run/respond", {
      answer: "Logan",
      leaseToken: "lease-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5100/internal/scheduled-run/respond"),
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
  });

  it("sends nothing while the secret is unset", async () => {
    mocks.env.SCHEDULED_RUN_SECRET = undefined;

    await expect(
      postScheduledRunRoute("/internal/scheduled-run/report", {
        runId: "run-1",
      })
    ).rejects.toThrow(
      "Scheduled-run callbacks are disabled. Set SCHEDULED_RUN_SECRET."
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reaches the eve development server that Next recorded", async () => {
    mocks.env.NODE_ENV = "development";

    await postScheduledRunRoute("/internal/scheduled-run/respond", {
      answer: "Logan",
      leaseToken: "lease-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:51829/internal/scheduled-run/respond"),
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
    expect(sentHeaders().get("authorization")).toBe(`Bearer ${secret}`);
  });

  it("ignores a development registry owned by another checkout", async () => {
    mocks.env.NODE_ENV = "development";
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        appRoot: "/tmp/another-checkout",
        origin: "http://127.0.0.1:51829",
      })
    );

    await postScheduledRunRoute("/internal/scheduled-run/report", {
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:4274/internal/scheduled-run/report"),
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
  });
});

function sentHeaders() {
  const call = vi.mocked(fetch).mock.calls[0];
  if (!call) throw new Error("No scheduled run request was sent.");
  return new Headers(call[1]?.headers);
}
