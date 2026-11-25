import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  googleCallbackPath,
  isEveCallbackPath,
} from "@shared/connectors/google/oauth";
import {
  googleAbilities,
  googleRequestedScopes,
  grantedGoogleAbilities,
} from "@shared/connectors/google/scopes";
import { productionEnvironmentProblems } from "@shared/environment/production";

const production = {
  ANTHROPIC_API_KEY: "anthropic-key",
  ASSIST_ALLOWED_EMAILS: "member@icommteam.com",
  BETTER_AUTH_SECRET: "production-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: "https://assist.icommteam.com",
  DATABASE_URL: "postgresql://user:password@db.internal/assist",
  KERNEL_API_KEY: "kernel-key",
  NODE_ENV: "production",
  SCHEDULED_RUN_SECRET: "scheduled-run-secret-0123456789abcdef",
  SECRET_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
};

describe("the Google connector's documented setup", () => {
  it("requests exactly the scopes the README lists, the narrowest for each call", async () => {
    const readme = await readFile("README.md", "utf8");
    const listed =
      /The scopes assist requests, exactly[^`]*```text\n([^`]*)```/u
        .exec(readme)?.[1]
        ?.trim()
        .split("\n");

    expect(listed).toEqual(googleRequestedScopes);
    expect(googleRequestedScopes).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/drive.readonly",
    ]);
    // Nothing that reaches more than the tools need.
    for (const broad of [
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive",
    ]) {
      expect(googleRequestedScopes).not.toContain(broad);
    }
  });

  it("documents the one redirect URI the OAuth client registers", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(googleCallbackPath).toBe("/api/connectors/google/callback");
    expect(readme).toContain(
      "```text\nhttps://assist.icommteam.com/api/connectors/google/callback\n```"
    );
  });

  it("reads what Google granted, ability by ability", () => {
    expect(grantedGoogleAbilities(googleRequestedScopes)).toEqual(
      googleAbilities.map((ability) => ability.id)
    );
    expect(
      grantedGoogleAbilities([
        "openid",
        "https://www.googleapis.com/auth/calendar.events",
      ])
    ).toEqual(["calendar-events"]);
  });
});

describe("eve's callback path", () => {
  it("takes only the path eve mints for one sign-in attempt", () => {
    expect(
      isEveCallbackPath(
        "/eve/v1/connections/google/callback/01JATTEMPT/eve%3Ainbox%3Av1%3Aeve%3Asession%3Awrun_1%3Ainbox"
      )
    ).toBe(true);
    for (const path of [
      "/eve/v1/callback/token",
      "/eve/v1/connections/google/callback/token",
      "/eve/v1/connections/../callback/a/b",
      "/eve/v1/connections/google/callback/a/..",
      "/eve/v1/connections/google/callback/a\\b/c",
      "/eve/v1/connections/google/callback/a/b?next=/",
      "//evil.example/eve/v1/connections/google/callback/a/b",
      "/api/connectors/google/callback",
    ]) {
      expect({ accepted: isEveCallbackPath(path), path }).toEqual({
        accepted: false,
        path,
      });
    }
  });
});

describe("the production boot guard", () => {
  it("accepts Google set up with both variables, or left off", () => {
    expect(productionEnvironmentProblems(production)).toEqual([]);
    expect(
      productionEnvironmentProblems({
        ...production,
        GOOGLE_CLIENT_ID: "1234-abc.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "client-secret",
      })
    ).toEqual([]);
  });

  it("refuses one variable alone, or an ID that is not an OAuth client's, naming no value", () => {
    const halfSet = productionEnvironmentProblems({
      ...production,
      GOOGLE_CLIENT_SECRET: "client-secret",
    });
    expect(halfSet).toEqual([
      "Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or leave both unset.",
    ]);
    const wrongId = productionEnvironmentProblems({
      ...production,
      GOOGLE_CLIENT_ID: "client-secret-pasted-here",
      GOOGLE_CLIENT_SECRET: "client-secret",
    });
    expect(wrongId).toEqual([
      "GOOGLE_CLIENT_ID must be an OAuth client ID ending in .apps.googleusercontent.com.",
    ]);
    expect(wrongId.join(" ")).not.toContain("client-secret");
  });
});
