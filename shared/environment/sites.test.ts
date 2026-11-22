import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const teemiqToken = "teemiq-test-token-0123456789abcdef";
const agentsToken = "agents-test-token-0123456789abcdef";
const stubbed = new Set<string>();

function stubSite(variable: string, value: string) {
  stubbed.add(variable);
  vi.stubEnv(variable, value);
}

async function loadSites() {
  return import("@shared/environment/sites");
}

describe("connected site configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    // An empty value is the same as an unset one for site variables.
    for (const variable of stubbed) vi.stubEnv(variable, "");
    stubbed.clear();
    vi.restoreAllMocks();
  });

  it("names the site whose token is presented, and no other", async () => {
    stubSite("ASSIST_SITE_TOKEN_TEEMIQ", ` ${teemiqToken} `);
    stubSite("ASSIST_SITE_OWNER_TEEMIQ", "owner@example.test");
    stubSite("ASSIST_SITE_TOKEN_AGENTS", agentsToken);
    stubSite("ASSIST_SITE_OWNER_AGENTS", "owner@example.test");
    stubSite("ASSIST_SITE_TOKEN_UNUSED", "");
    const { siteForToken } = await loadSites();

    expect(siteForToken(teemiqToken)).toBe("teemiq");
    expect(siteForToken(agentsToken)).toBe("agents");
    expect(siteForToken(`${teemiqToken}x`)).toBeUndefined();
    expect(siteForToken(teemiqToken.toUpperCase())).toBeUndefined();
    expect(siteForToken("")).toBeUndefined();
  });

  it("accepts no token when no site is configured", async () => {
    const { siteForToken } = await loadSites();

    expect(siteForToken(teemiqToken)).toBeUndefined();
  });

  it("disables a site whose token is too short and logs only the variable", async () => {
    stubSite("ASSIST_SITE_TOKEN_TEEMIQ", "short-token");
    stubSite("ASSIST_SITE_OWNER_TEEMIQ", "owner@example.test");
    const { siteForToken } = await loadSites();

    expect(siteForToken("short-token")).toBeUndefined();
    expect(siteForToken("short-token")).toBeUndefined();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "[site] ASSIST_SITE_TOKEN_TEEMIQ is shorter than 32 characters; the site is disabled."
    );
  });

  it("disables both sites when they share a token", async () => {
    stubSite("ASSIST_SITE_TOKEN_TEEMIQ", teemiqToken);
    stubSite("ASSIST_SITE_TOKEN_AGENTS", teemiqToken);
    const { siteForToken } = await loadSites();

    expect(siteForToken(teemiqToken)).toBeUndefined();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      teemiqToken
    );
  });

  it("reads the owner case-insensitively and refuses an invalid one", async () => {
    stubSite("ASSIST_SITE_TOKEN_TEEMIQ", teemiqToken);
    stubSite("ASSIST_SITE_OWNER_TEEMIQ", " Owner@Example.TEST ");
    stubSite("ASSIST_SITE_TOKEN_AGENTS", agentsToken);
    stubSite("ASSIST_SITE_OWNER_AGENTS", "not-an-email");
    const { siteForToken, siteOwnerEmail } = await loadSites();

    expect(siteOwnerEmail("teemiq")).toBe("owner@example.test");
    expect(siteOwnerEmail("agents")).toBeUndefined();
    expect(siteForToken(agentsToken)).toBe("agents");
    expect(siteOwnerEmail("unknown")).toBeUndefined();
  });
});
