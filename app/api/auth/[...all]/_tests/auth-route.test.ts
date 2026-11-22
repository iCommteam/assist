/* oxlint-disable vitest/require-mock-type-parameters -- Auth initialization needs a deliberately partial Better Auth fixture. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handler = vi.fn<(request: Request) => Promise<Response>>();
const mocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  toNextJsHandler: vi.fn(),
}));

vi.mock("@db/services/auth", () => ({ getAuth: mocks.getAuth }));
vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: mocks.toNextJsHandler,
}));

beforeEach(() => {
  vi.clearAllMocks();
  handler.mockResolvedValue(Response.json({ ok: true }));
  mocks.toNextJsHandler.mockReturnValue({
    DELETE: handler,
    GET: handler,
    PATCH: handler,
    POST: handler,
    PUT: handler,
  });
});

describe("auth route initialization", () => {
  it("retries after transient installation-secret failures", async () => {
    mocks.getAuth
      .mockRejectedValueOnce(new Error("Secrets temporarily unavailable"))
      .mockResolvedValueOnce({});
    const { GET } = await import("@app/api/auth/[...all]/route");
    const request = new Request(
      "https://openinstinct.example/api/auth/get-session"
    );

    await expect(GET(request)).rejects.toThrow(
      "Secrets temporarily unavailable"
    );
    await expect(GET(request)).resolves.toMatchObject({ status: 200 });
    expect(mocks.getAuth).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("auth route exposure", () => {
  it.each([
    ["GET", "/ok"],
    ["GET", "/reset-password/some-token"],
    ["GET", "/callback/google"],
    ["GET", "/delete-user/callback"],
    ["GET", "/list-sessions"],
    ["GET", "/sign-in/email"],
    ["POST", "/get-session"],
    ["POST", "/sign-in/social"],
    ["POST", "/sign-in/phone-number"],
    ["POST", "/phone-number/send-otp"],
    ["POST", "/sign-in/magic-link"],
    ["POST", "/request-password-reset"],
    ["POST", "/reset-password"],
    ["POST", "/change-email"],
    ["POST", "/change-password"],
    ["POST", "/delete-user"],
    ["POST", "/update-user"],
    ["POST", "/update-session"],
    ["POST", "/revoke-sessions"],
    ["POST", "/link-social"],
    ["POST", "/get-access-token"],
    ["POST", "/refresh-token"],
    ["POST", "/two-factor/disable"],
    ["POST", "/two-factor/get-totp-uri"],
    ["POST", "/two-factor/generate-backup-codes"],
    ["POST", "/two-factor/send-otp"],
    ["POST", "/two-factor/verify-otp"],
    ["POST", "/sign-in/email/"],
  ])("answers %s %s with 404 without loading auth", async (method, path) => {
    const { GET, POST } = await import("@app/api/auth/[...all]/route");
    const request = new Request(
      `https://openinstinct.example/api/auth${path}`,
      { method }
    );

    const response = await (method === "GET" ? GET : POST)(request);

    expect(response.status).toBe(404);
    expect(mocks.getAuth).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/get-session"],
    ["POST", "/sign-in/email"],
    ["POST", "/sign-out"],
    ["POST", "/sign-up/email"],
    ["POST", "/two-factor/enable"],
    ["POST", "/two-factor/verify-backup-code"],
    ["POST", "/two-factor/verify-totp"],
  ])("passes %s %s to Better Auth", async (method, path) => {
    mocks.getAuth.mockResolvedValue({});
    const { GET, POST } = await import("@app/api/auth/[...all]/route");
    const request = new Request(
      `https://openinstinct.example/api/auth${path}`,
      { method }
    );

    const response = await (method === "GET" ? GET : POST)(request);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(request);
  });
});
