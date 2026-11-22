/* oxlint-disable vitest/require-mock-type-parameters -- Session lookup needs a deliberately partial Better Auth fixture. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authSessionFor,
  passwordOnlySessionFor,
} from "@tests/helpers/auth-session";

const mocks = vi.hoisted(() => ({ getAuth: vi.fn(), getSession: vi.fn() }));

vi.mock("@db/services/auth", () => ({ getAuth: mocks.getAuth }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubEnv("ASSIST_ALLOWED_EMAILS", "Member@Example.test");
  mocks.getAuth.mockResolvedValue({
    api: { getSession: mocks.getSession },
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

async function sessionReaders() {
  return await import("@db/services/auth/session");
}

describe("auth session", () => {
  it("accepts a listed, enrolled member whose session proved a second factor", async () => {
    const complete = authSessionFor({
      email: "member@EXAMPLE.test",
      id: "user-1",
    });
    mocks.getSession.mockResolvedValue(complete);
    const { getAuthSession } = await sessionReaders();

    await expect(getAuthSession(new Headers())).resolves.toEqual(complete);
  });

  it.each([
    [
      "an unlisted email",
      authSessionFor({ email: "outsider@example.test", id: "user-2" }),
    ],
    [
      "a session without a completed second factor",
      passwordOnlySessionFor({ email: "member@example.test", id: "user-3" }),
    ],
    [
      "a member without an enrolled authenticator",
      passwordOnlySessionFor({
        email: "member@example.test",
        id: "user-4",
        twoFactorEnabled: false,
      }),
    ],
    ["no session", null],
  ])("refuses %s", async (_case, value) => {
    mocks.getSession.mockResolvedValue(value);
    const { getAuthSession } = await sessionReaders();

    await expect(getAuthSession(new Headers())).resolves.toBeNull();
  });

  it("refuses every session when no team list is configured", async () => {
    vi.stubEnv("ASSIST_ALLOWED_EMAILS", "");
    mocks.getSession.mockResolvedValue(
      authSessionFor({ email: "member@example.test", id: "user-1" })
    );
    const { getAuthSession, getTwoFactorSetupSession } = await sessionReaders();

    await expect(getAuthSession(new Headers())).resolves.toBeNull();
    await expect(getTwoFactorSetupSession(new Headers())).resolves.toBeNull();
  });

  it("offers setup only to a listed member's password-only session", async () => {
    const { getTwoFactorSetupSession } = await sessionReaders();
    mocks.getSession
      .mockResolvedValueOnce(
        passwordOnlySessionFor({
          email: "Member@example.test",
          id: "user-1",
          twoFactorEnabled: false,
        })
      )
      .mockResolvedValueOnce(
        authSessionFor({ email: "member@example.test", id: "user-1" })
      )
      .mockResolvedValueOnce(
        passwordOnlySessionFor({ email: "outsider@example.test", id: "user-2" })
      );

    await expect(getTwoFactorSetupSession(new Headers())).resolves.toEqual({
      email: "Member@example.test",
      enrolled: false,
    });
    await expect(getTwoFactorSetupSession(new Headers())).resolves.toBeNull();
    await expect(getTwoFactorSetupSession(new Headers())).resolves.toBeNull();
  });
});
