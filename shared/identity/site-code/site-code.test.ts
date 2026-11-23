import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSiteCodeQuestion,
  siteCodeQuestionTitle,
} from "@shared/identity/site-code/question";
import {
  openSiteCode,
  sealSiteCode,
  siteCodeSchema,
} from "@shared/identity/site-code/seal";

const secret = "site-code-test-secret-0123456789abcdef";

describe("sealed site code", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-23T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens only for the session it was sealed for, and never shows the code", () => {
    const sealed = sealSiteCode(secret, "wrun_task", "482913");

    expect(sealed).toMatch(/^assist-code\.v1\.[\w-]+$/u);
    expect(sealed).not.toContain("482913");
    expect(Buffer.from(sealed.slice(15), "base64url").toString()).not.toContain(
      "482913"
    );
    expect(openSiteCode(secret, "wrun_task", sealed)).toBe("482913");
    expect(openSiteCode(secret, "wrun_other", sealed)).toBeUndefined();
    expect(
      openSiteCode(`${secret}-other`, "wrun_task", sealed)
    ).toBeUndefined();
  });

  it("seals the same code differently each time", () => {
    expect(sealSiteCode(secret, "wrun_task", "482913")).not.toBe(
      sealSiteCode(secret, "wrun_task", "482913")
    );
  });

  it("expires ten minutes after it is sealed", () => {
    const sealed = sealSiteCode(secret, "wrun_task", "482913");

    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(openSiteCode(secret, "wrun_task", sealed)).toBe("482913");
    vi.advanceTimersByTime(1);
    expect(openSiteCode(secret, "wrun_task", sealed)).toBeUndefined();
  });

  it("refuses a sealed value changed after sealing", () => {
    const sealed = sealSiteCode(secret, "wrun_task", "482913");
    const bytes = Buffer.from(sealed.slice(15), "base64url");
    bytes[20] = (bytes[20] ?? 0) ^ 1;

    expect(
      openSiteCode(
        secret,
        "wrun_task",
        `assist-code.v1.${bytes.toString("base64url")}`
      )
    ).toBeUndefined();
  });

  it.each([
    "",
    "482913",
    "assist-code.v1.",
    "assist-code.v1.short",
    "assist-code.v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ])("refuses the unsealed answer %j", (value) => {
    expect(openSiteCode(secret, "wrun_task", value)).toBeUndefined();
  });

  it("accepts one trimmed line of up to 64 characters", () => {
    expect(siteCodeSchema.parse(" AB12-CD34 ")).toBe("AB12-CD34");
    expect(siteCodeSchema.parse("123 456")).toBe("123 456");
    expect(siteCodeSchema.safeParse("x".repeat(64)).success).toBe(true);
    for (const text of ["", "   ", "x".repeat(65), "1234\n56", "12\t34"]) {
      expect(siteCodeSchema.safeParse(text).success).toBe(false);
    }
  });
});

describe("site code question", () => {
  it("is a question titled as the code question, which a model cannot set", () => {
    expect(
      isSiteCodeQuestion({ kind: "question", title: siteCodeQuestionTitle })
    ).toBe(true);
    expect(isSiteCodeQuestion({ kind: "question" })).toBe(false);
    expect(
      isSiteCodeQuestion({ kind: "approval", title: siteCodeQuestionTitle })
    ).toBe(false);
    expect(
      isSiteCodeQuestion({ kind: "budget", title: siteCodeQuestionTitle })
    ).toBe(false);
  });
});
