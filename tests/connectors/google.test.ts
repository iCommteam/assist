import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import { encryptedSecrets } from "@db/schema";
import { z } from "zod";
import { googleRequestedScopes } from "@shared/connectors/google/scopes";
import { accessScopeForUser } from "@shared/identity/access-scope";

// The whole connect, against a fake Google at the fetch boundary and a real
// PostgreSQL schema: the Workspace page's button, a chat's sign-in through
// eve's callback, refresh, and Disconnect. Every secret is a sentinel that
// must never show up anywhere but Google's own endpoints.
vi.hoisted(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "assist-test.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "sentinel-client-secret-0123456789");
});

const clientSecret = "sentinel-client-secret-0123456789";
const authorizationCode = "4/sentinel-authorization-code-0123456789";
const accessToken = "ya29.sentinel-access-token-0123456789";
const refreshedToken = "ya29.sentinel-refreshed-token-0123456789";
const refreshToken = "1//sentinel-refresh-token-0123456789";
const sentinels = [
  clientSecret,
  authorizationCode,
  accessToken,
  refreshedToken,
  refreshToken,
];

vi.mock("@db/services/auth/session", () => ({
  async getAuthSession(headers: Headers) {
    const id = headers.get("x-test-user");
    return id
      ? {
          session: { twoFactorVerified: true },
          user: { email: `${id}@icommteam.com`, id, twoFactorEnabled: true },
        }
      : null;
  },
}));

// What the fake Google saw and how it answers.
interface FakeGoogle {
  refresh: "down" | "invalid_grant" | "ok";
  revoke: "down" | "ok";
  readonly revoked: string[];
  readonly tokenRequests: URLSearchParams[];
}
const google: FakeGoogle = {
  refresh: "ok",
  revoke: "ok",
  revoked: [],
  tokenRequests: [],
};

const { GET: callback } =
  await import("@app/api/connectors/google/callback/route");
const { POST: start } = await import("@app/api/connectors/google/start/route");
const { POST: disconnect } =
  await import("@app/api/connectors/google/disconnect/route");
const { googleAuth } = await import("@agent/lib/google/auth");
const connectors = await import("@db/services/connectors/google");
const { ensureScope } = await import("@db/services/scope");
const {
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} = await import("eve/connections");

const client = new PGlite();
const database = drizzle(client, { schema });
const memberA = accessScopeForUser("better-auth:user-a");
const memberB = accessScopeForUser("better-auth:user-b");
const principalA = principalOf(memberA, "user-a");
const principalB = principalOf(memberB, "user-b");
const eveCallback =
  "/eve/v1/connections/google/callback/01JATTEMPT0000000000000000/eve%3Ainbox%3Av1%3Aeve%3Asession%3Awrun_1%3Ainbox";
const logged: string[] = [];

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
  vi.stubGlobal("fetch", fakeGoogle);
  for (const method of ["debug", "error", "info", "log", "warn"] as const) {
    vi.spyOn(console, method).mockImplementation((...values) => {
      logged.push(values.map((value) => String(value)).join(" "));
    });
  }
}, 30_000);

beforeEach(async () => {
  google.refresh = "ok";
  google.revoke = "ok";
  google.revoked.length = 0;
  google.tokenRequests.length = 0;
  await database.delete(encryptedSecrets);
});

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await client.close();
});

describe("connecting from the Workspace page", () => {
  it("sends the member to Google with PKCE, a state and the documented scopes", async () => {
    const consent = new URL(await startedFrom("user-a"));

    expect(`${consent.origin}${consent.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    const {
      code_challenge: challenge,
      state,
      ...fixed
    } = Object.fromEntries(consent.searchParams);
    expect(challenge).toMatch(/^[\w-]{43}$/u);
    expect(state).toMatch(/^[\w-]{43}$/u);
    expect(fixed).toEqual({
      access_type: "offline",
      client_id: "assist-test.apps.googleusercontent.com",
      code_challenge_method: "S256",
      include_granted_scopes: "true",
      login_hint: "user-a@icommteam.com",
      prompt: "consent",
      redirect_uri: "https://example.com/api/connectors/google/callback",
      response_type: "code",
      scope: googleRequestedScopes.join(" "),
    });
    expect(consent.toString()).not.toContain(clientSecret);
  });

  it("keeps the tokens sealed, and proves the verifier to Google", async () => {
    const consent = new URL(await startedFrom("user-a"));
    const state = consent.searchParams.get("state") ?? "";

    const back = await googleRedirect("user-a", {
      code: authorizationCode,
      state,
    });

    expect(back.headers.get("location")).toBe(
      "https://example.com/?google=connected#connectors"
    );
    const [exchange] = google.tokenRequests;
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.get("redirect_uri")).toBe(
      "https://example.com/api/connectors/google/callback"
    );
    expect(
      createHash("sha256")
        .update(exchange?.get("code_verifier") ?? "")
        .digest("base64url")
    ).toBe(consent.searchParams.get("code_challenge"));
    const account = await connectors.googleAccountOf(memberA);
    expect(Date.parse(account?.connectedAt ?? "")).not.toBeNaN();
    expect(account).toMatchObject({
      email: "user-a@icommteam.com",
      needsReconnect: false,
      scopes: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        ...googleRequestedScopes.slice(2),
      ],
    });
    const rows = await database
      .select()
      .from(encryptedSecrets)
      .where(eq(encryptedSecrets.workspaceId, memberA.workspaceId));
    // The account alone: the flow was spent.
    expect(rows.map(({ id, namespace }) => ({ id, namespace }))).toEqual([
      { id: "google", namespace: "connector" },
    ]);
    for (const sentinel of sentinels) {
      expect(JSON.stringify(rows)).not.toContain(sentinel);
    }
  });

  it("spends a flow once, and connects nothing Google denied or that expired", async () => {
    const denied = new URL(await startedFrom("user-a")).searchParams.get(
      "state"
    );
    const refused = await googleRedirect("user-a", {
      error: "access_denied",
      state: denied ?? "",
    });
    expect(refused.headers.get("location")).toBe(
      "https://example.com/?google=denied#connectors"
    );
    const replayed = await googleRedirect("user-a", {
      code: authorizationCode,
      state: denied ?? "",
    });
    expect(replayed.headers.get("location")).toBe(
      "https://example.com/?google=expired#connectors"
    );

    const late = new URL(await startedFrom("user-a")).searchParams.get("state");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    const expired = await googleRedirect("user-a", {
      code: authorizationCode,
      state: late ?? "",
    });
    vi.mocked(Date.now).mockRestore();

    expect(expired.headers.get("location")).toBe(
      "https://example.com/?google=expired#connectors"
    );
    expect(google.tokenRequests).toEqual([]);
    await expect(connectors.googleAccountOf(memberA)).resolves.toBeUndefined();
  });
});

describe("each member's own account", () => {
  it("never lets one member finish another's connect or use another's tokens", async () => {
    const state =
      new URL(await startedFrom("user-a")).searchParams.get("state") ?? "";

    const stolen = await googleRedirect("user-b", {
      code: authorizationCode,
      state,
    });
    expect(stolen.headers.get("location")).toBe(
      "https://example.com/?google=expired#connectors"
    );
    expect(google.tokenRequests).toEqual([]);

    // Member A's flow was untouched and still finishes.
    const own = await googleRedirect("user-a", {
      code: authorizationCode,
      state,
    });
    expect(own.headers.get("location")).toBe(
      "https://example.com/?google=connected#connectors"
    );
    await expect(tokenOf(principalA)).resolves.toMatchObject({
      token: accessToken,
    });
    await expect(tokenOf(principalB)).rejects.toSatisfy(
      isConnectionAuthorizationRequiredError
    );

    // A's sealed row copied into B's workspace does not open there.
    await ensureScope(memberB);
    const [row] = await database
      .select()
      .from(encryptedSecrets)
      .where(eq(encryptedSecrets.workspaceId, memberA.workspaceId));
    if (!row) throw new Error("Expected member A's account row.");
    await database
      .insert(encryptedSecrets)
      .values({ ...row, workspaceId: memberB.workspaceId });
    await expect(connectors.googleAccountOf(memberB)).resolves.toBeUndefined();
    await expect(tokenOf(principalB)).rejects.toSatisfy(
      isConnectionAuthorizationRequiredError
    );
  });
});

describe("connecting from a chat's sign-in", () => {
  it("continues at eve's callback on assist's origin, with only the state in eve's records", async () => {
    const started = await googleAuth.startAuthorization({
      callbackUrl: `http://127.0.0.1:4274${eveCallback}`,
      connection: { url: "" },
      principal: principalA,
    });
    const consent = new URL(started.challenge.url ?? "");
    const state = consent.searchParams.get("state") ?? "";
    expect(started.resume).toEqual({ state });
    expect(started.challenge.displayName).toBe("Google");
    expect(Date.parse(started.challenge.expiresAt ?? "")).toBeGreaterThan(
      Date.now()
    );
    expect(consent.searchParams.get("redirect_uri")).toBe(
      "https://example.com/api/connectors/google/callback"
    );

    const back = await googleRedirect("user-a", {
      code: authorizationCode,
      state,
    });

    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(
      `https://example.com${eveCallback}?state=${state}`
    );
    const verifier = google.tokenRequests[0]?.get("code_verifier") ?? "";
    expect(verifier).not.toBe("");
    expect(JSON.stringify(started)).not.toContain(verifier);
    expect(JSON.stringify(started)).not.toContain("wrun_1");

    const completed = await googleAuth.completeAuthorization({
      callback: { method: "GET", params: { state } },
      callbackUrl: `http://127.0.0.1:4274${eveCallback}`,
      connection: { url: "" },
      principal: principalA,
      resume: started.resume,
    });
    expect(completed.expiresAt).toBeGreaterThan(Date.now());
    expect(completed).toMatchObject({
      providerSubject: "google-sub-user-a",
      token: accessToken,
    });
    await expect(
      googleAuth.completeAuthorization({
        callback: { method: "GET", params: { state: "another-state" } },
        callbackUrl: `http://127.0.0.1:4274${eveCallback}`,
        connection: { url: "" },
        principal: principalA,
        resume: started.resume,
      })
    ).rejects.toSatisfy(isConnectionAuthorizationFailedError);
  });

  it("ends the chat's sign-in as not granted when Google was denied", async () => {
    const started = await googleAuth.startAuthorization({
      callbackUrl: `http://127.0.0.1:4274${eveCallback}`,
      connection: { url: "" },
      principal: principalA,
    });
    const state =
      new URL(started.challenge.url ?? "").searchParams.get("state") ?? "";

    const back = await googleRedirect("user-a", {
      error: "access_denied",
      state,
    });
    const location = new URL(back.headers.get("location") ?? "");
    expect(location.pathname).toBe(eveCallback);
    expect(location.searchParams.get("error")).toBe("denied");

    const failure = await googleAuth
      .completeAuthorization({
        callback: {
          method: "GET",
          params: Object.fromEntries(location.searchParams),
        },
        callbackUrl: `http://127.0.0.1:4274${eveCallback}`,
        connection: { url: "" },
        principal: principalA,
        resume: started.resume,
      })
      .then(
        () => undefined,
        (cause: unknown) => cause
      );
    expect(failure).toMatchObject({
      reason: "access_denied",
      retryable: false,
    });
  });

  it("refuses a callback eve did not mint for a sign-in", async () => {
    await expect(
      googleAuth.startAuthorization({
        callbackUrl: "https://example.com/eve/v1/connections/../callback/x/y",
        connection: { url: "" },
        principal: principalA,
      })
    ).rejects.toSatisfy(isConnectionAuthorizationFailedError);
  });
});

describe("refresh", () => {
  it("refreshes an expiring token, keeps the grant when Google is down, and asks to connect again only when Google refuses it", async () => {
    await connect("user-a");

    await connectors.dropGoogleAccessToken(memberA);
    await expect(tokenOf(principalA)).resolves.toMatchObject({
      token: refreshedToken,
    });
    expect(google.tokenRequests.at(-1)?.get("refresh_token")).toBe(
      refreshToken
    );

    await connectors.dropGoogleAccessToken(memberA);
    google.refresh = "down";
    await expect(tokenOf(principalA)).rejects.toMatchObject({
      reason: "google_unavailable",
    });
    await expect(connectors.googleAccountOf(memberA)).resolves.toMatchObject({
      needsReconnect: false,
    });

    google.refresh = "invalid_grant";
    await expect(tokenOf(principalA)).rejects.toSatisfy(
      isConnectionAuthorizationRequiredError
    );
    await expect(connectors.googleAccountOf(memberA)).resolves.toMatchObject({
      email: "user-a@icommteam.com",
      needsReconnect: true,
    });
    const requests = google.tokenRequests.length;
    await expect(tokenOf(principalA)).rejects.toSatisfy(
      isConnectionAuthorizationRequiredError
    );
    expect(google.tokenRequests).toHaveLength(requests);
  });
});

describe("Disconnect", () => {
  it("revokes the grant at Google and deletes the account", async () => {
    await connect("user-a");

    const answer = await disconnect(
      request("POST", "/api/connectors/google/disconnect", "user-a")
    );

    await expect(answer.json()).resolves.toEqual({ outcome: "disconnected" });
    expect(google.revoked).toEqual([refreshToken]);
    await expect(
      database
        .select()
        .from(encryptedSecrets)
        .where(
          and(
            eq(encryptedSecrets.workspaceId, memberA.workspaceId),
            eq(encryptedSecrets.namespace, "connector")
          )
        )
    ).resolves.toEqual([]);
    await expect(tokenOf(principalA)).rejects.toSatisfy(
      isConnectionAuthorizationRequiredError
    );
  });

  it("deletes the account even when Google cannot confirm the revoke, and says so", async () => {
    await connect("user-a");
    google.revoke = "down";

    const answer = await disconnect(
      request("POST", "/api/connectors/google/disconnect", "user-a")
    );

    await expect(answer.json()).resolves.toEqual({ outcome: "unrevoked" });
    await expect(connectors.googleAccountOf(memberA)).resolves.toBeUndefined();
  });
});

describe("secrets", () => {
  it("never logged a token, the code or the client secret", async () => {
    await connect("user-a");
    await connectors.dropGoogleAccessToken(memberA);
    await tokenOf(principalA);
    await disconnect(
      request("POST", "/api/connectors/google/disconnect", "user-a")
    );
    for (const sentinel of sentinels) {
      expect(logged.join("\n")).not.toContain(sentinel);
    }
  });
});

function principalOf(scope: typeof memberA, id: string) {
  return {
    attributes: {
      email: `${id}@icommteam.com`,
      workspaceId: scope.workspaceId,
    },
    id: scope.userId,
    type: "user" as const,
  };
}

function tokenOf(principal: typeof principalA) {
  return googleAuth.getToken({ connection: { url: "" }, principal });
}

function request(method: string, path: string, user: string) {
  return new Request(new URL(path, "https://example.com"), {
    headers: { origin: "https://example.com", "x-test-user": user },
    method,
  });
}

async function startedFrom(user: string) {
  const answer = await start(
    request("POST", "/api/connectors/google/start", user)
  );
  expect(answer.status).toBe(200);
  return z.object({ url: z.string() }).parse(await answer.json()).url;
}

function googleRedirect(
  user: string,
  params: Readonly<Record<string, string>>
) {
  const url = new URL("/api/connectors/google/callback", "https://example.com");
  url.search = new URLSearchParams(params).toString();
  return callback(request("GET", url.pathname + url.search, user));
}

async function connect(user: string) {
  const state =
    new URL(await startedFrom(user)).searchParams.get("state") ?? "";
  await googleRedirect(user, { code: authorizationCode, state });
}

// Google's token and revoke endpoints, as their documentation describes them.
async function fakeGoogle(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : input);
  const form =
    init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
  if (url.toString() === "https://oauth2.googleapis.com/revoke") {
    google.revoked.push(form.get("token") ?? "");
    return google.revoke === "ok"
      ? new Response(null, { status: 200 })
      : new Response("unavailable", { status: 503 });
  }
  if (url.toString() !== "https://oauth2.googleapis.com/token") {
    throw new Error(`Unexpected request to ${url.origin}`);
  }
  google.tokenRequests.push(form);
  if (form.get("client_secret") !== clientSecret) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }
  if (form.get("grant_type") === "authorization_code") {
    if (form.get("code") !== authorizationCode) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    // Only member A ever completes a connect in these tests.
    return Response.json({
      access_token: accessToken,
      expires_in: 3599,
      id_token: idToken("user-a"),
      refresh_token: refreshToken,
      scope: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        ...googleRequestedScopes.slice(2),
      ].join(" "),
      token_type: "Bearer",
    });
  }
  if (google.refresh === "down") return new Response("down", { status: 500 });
  if (google.refresh === "invalid_grant") {
    return Response.json(
      { error: "invalid_grant", error_description: "Token has been revoked." },
      { status: 400 }
    );
  }
  return Response.json({
    access_token: refreshedToken,
    expires_in: 3599,
    token_type: "Bearer",
  });
}

function jwtPart(value: Readonly<Record<string, string>>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function idToken(user: string) {
  return `${jwtPart({ alg: "RS256" })}.${jwtPart({ email: `${user}@icommteam.com`, sub: `google-sub-${user}` })}.signature`;
}
