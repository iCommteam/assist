import { PGlite } from "@electric-sql/pglite";
import type * as KernelSdk from "@onkernel/sdk";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type * as EveClient from "eve/client";
import type { Fact, ReceivedEvent } from "eve/events";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

vi.hoisted(() => {
  vi.stubEnv("ASSIST_ALLOWED_EMAILS", "owner@example.test");
});

const eve = vi.hoisted(() => ({
  bearers: new Array<() => Promise<string>>(),
  create:
    vi.fn<
      (input: { message: string }) => Promise<{ session: { id: string } }>
    >(),
  read: vi.fn<(sessionId: string) => Promise<ReceivedEvent[]>>(),
}));
const kernel = vi.hoisted(() => ({
  deleteProfile:
    vi.fn<
      (
        idOrName: string,
        options: { readonly signal: AbortSignal }
      ) => Promise<void>
    >(),
}));

vi.mock("eve/client", async (importOriginal) => {
  const original = await importOriginal<typeof EveClient>();
  class FakeClient {
    readonly sessions = {
      attach: (sessionId: string) => ({
        async *stream() {
          yield* await eve.read(sessionId);
        },
      }),
      create: eve.create,
    };

    constructor(options: { auth: { bearer: () => Promise<string> } }) {
      eve.bearers.push(options.auth.bearer);
    }
  }
  return { ...original, Client: FakeClient };
});
vi.mock("@onkernel/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof KernelSdk>()),
  default: class {
    profiles = { delete: kernel.deleteProfile };
  },
}));

import * as Database from "@db";
import * as schema from "@db/schema";
import { ensureScope } from "@db/services/scope";
import { recordSiteTask } from "@db/services/sites";
import {
  listVaultItems,
  readVaultSecret,
  saveVaultItem,
} from "@db/services/vault";
import { kernelProfileNameForLogin } from "@shared/browser/kernel-profile";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { verifySiteCredential } from "@shared/identity/site-credential";
import {
  parseLoginVaultPayload,
  serializeLoginVaultPayload,
} from "@shared/vault/schema";
import { eventsOf } from "@tests/helpers/session-view";

const { GET: listLogins, POST: postLogin } =
  await import("@app/api/site/logins/route");
const { DELETE: removeLogin } =
  await import("@app/api/site/logins/[loginId]/route");
const { POST: createTask } = await import("@app/api/site/tasks/route");
const { ClientError } = await import("eve/client");

const client = new PGlite();
const database = drizzle(client, { schema });
// SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real routes, schema and services with an isolated PostgreSQL-compatible test database.
const testDatabase = database as never;
const owner = accessScopeForUser("better-auth:owner-id");
const teemiqToken = "teemiq-test-token-0123456789abcdef";
const agentsToken = "agents-test-token-0123456789abcdef";
const authSecret = "test-auth-secret-0123456789abcdefghijklmnop";
const siteVariables = [
  ["ASSIST_SITE_TOKEN_TEEMIQ", teemiqToken],
  ["ASSIST_SITE_OWNER_TEEMIQ", "owner@example.test"],
  ["ASSIST_SITE_TOKEN_AGENTS", agentsToken],
  ["ASSIST_SITE_OWNER_AGENTS", "owner@example.test"],
] as const;

const identifier = "vadim@vendor.example";
const password = "correct horse battery staple";
const totpSecret = "JBSWY3DPEHPK3PXP";
const totpLink = `otpauth://totp/Vendor:vadim?secret=${totpSecret}&issuer=Vendor`;
const secrets = [identifier, password, totpSecret, totpSecret.toLowerCase()];

// Every answer the routes gave in a test, read back as text.
const answers: string[] = [];

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  vi.spyOn(Database, "db", "get").mockReturnValue(testDatabase);
  await database.insert(schema.user).values({
    email: "owner@example.test",
    id: "owner-id",
    name: "Owner",
    twoFactorEnabled: true,
  });
  await ensureScope(owner);
}, 30_000);

beforeEach(async () => {
  vi.clearAllMocks();
  answers.length = 0;
  eve.bearers.length = 0;
  for (const [name, value] of siteVariables) vi.stubEnv(name, value);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  eve.create.mockResolvedValue({ session: { id: "wrun_pinned" } });
  eve.read.mockResolvedValue(completedTask());
  kernel.deleteProfile.mockResolvedValue();
  await database.delete(schema.siteTasks);
  await database.delete(schema.vaultItems);
});

// No answer and no log line of any test, failures included, carries a secret.
afterEach(() => {
  for (const [name] of siteVariables) vi.stubEnv(name, "");
  const seen = [
    ...answers,
    JSON.stringify(vi.mocked(console.warn).mock.calls),
    JSON.stringify(vi.mocked(console.info).mock.calls),
  ].join("\n");
  if (secrets.some((secret) => seen.includes(secret))) {
    throw new Error("A login secret reached an answer or a log line.");
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("POST /api/site/logins", () => {
  it("saves the login in the owner's vault, marked with the site, and answers without its secrets", async () => {
    const response = await call(
      postLogin(
        loginRequest(teemiqToken, {
          identifier,
          label: "  Vendor (Vadim)  ",
          origin: "https://login.vendor.example/sign-in?next=%2Finvoices#top",
          password,
          totp: totpLink,
        })
      )
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const login = await loginOf(response);
    expect(login).toMatchObject({
      hasTotp: true,
      label: "Vendor (Vadim)",
      origin: "https://login.vendor.example",
    });
    expect(new Date(login.createdAt).toISOString()).toBe(login.createdAt);
    expect(z.uuid().safeParse(login.loginId).success).toBe(true);
    const [item] = await listVaultItems(owner);
    expect(item).toMatchObject({
      createdAt: login.createdAt,
      id: login.loginId,
      kind: "login",
      label: "Vendor (Vadim)",
      site: "teemiq",
    });
    const saved = parseLoginVaultPayload(
      (await readVaultSecret(owner, login.loginId)) ?? ""
    );
    expect(saved).toMatchObject({
      authentication: {
        password,
        totp: { algorithm: "SHA1", digits: 6, period: 30, secret: totpSecret },
        type: "password",
      },
      identifier: { type: "email", value: identifier },
      origin: "https://login.vendor.example",
      version: 2,
    });
    expect(console.info).toHaveBeenCalledExactlyOnceWith("[site] login saved", {
      site: "teemiq",
    });
  });

  it("takes a bare base32 key, and no key when the field is blank or left out", async () => {
    const saved = await Promise.all(
      [
        { label: "Spaced key", totp: "jbsw y3dp ehpk 3pxp" },
        { label: "Blank key", totp: "  " },
        { label: "Null key", totp: null },
        { label: "No key" },
      ].map(async (fields) => {
        const response = await call(
          postLogin(
            loginRequest(teemiqToken, {
              identifier: "vadim",
              origin: "https://billing.vendor.example",
              password,
              ...fields,
            })
          )
        );
        return (await loginOf(response)).hasTotp;
      })
    );

    expect(saved).toEqual([true, false, false, false]);
    const [username] = await listVaultItems(owner);
    expect(
      parseLoginVaultPayload(
        (await readVaultSecret(owner, username?.id ?? "")) ?? ""
      )?.identifier
    ).toEqual({ type: "username", value: "vadim" });
  });

  it.each([
    ["a key that is not base32", "not a key at all 1"],
    ["a counter-based link", `otpauth://hotp/Vendor?secret=${totpSecret}`],
    ["a link with no secret", "otpauth://totp/Vendor?issuer=Vendor"],
  ])("answers invalid_totp for %s, saving nothing", async (_case, totp) => {
    const response = await call(
      postLogin(loginRequest(teemiqToken, validLogin({ totp })))
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_totp" });
    await expect(listVaultItems(owner)).resolves.toEqual([]);
  });

  it.each([
    ["an http origin", "http://login.vendor.example"],
    ["another scheme", "ftp://login.vendor.example"],
    ["no scheme", "login.vendor.example"],
    ["an IPv4 address", "https://192.0.2.10/login"],
    ["an IPv4 address in hex", "https://0x7f.1"],
    ["an IPv6 address", "https://[2001:db8::1]"],
    ["localhost", "https://localhost"],
    ["a localhost subdomain", "https://billing.localhost"],
    ["a single-label host", "https://intranet/login"],
    ["a bare public suffix", "https://co.uk"],
    ["a port", "https://login.vendor.example:8443/login"],
    ["the default port written out", "https://login.vendor.example:443"],
    ["user info", "https://vadim:pw@login.vendor.example"],
    ["a trailing dot", "https://login.vendor.example./login"],
    ["a control character", "https://login.vendor\n.example"],
    ["an empty origin", ""],
  ])("refuses %s with invalid_request", async (_case, origin) => {
    const response = await call(
      postLogin(loginRequest(teemiqToken, validLogin({ origin })))
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
    await expect(listVaultItems(owner)).resolves.toEqual([]);
  });

  it.each([
    ["an empty label", { label: "" }],
    ["a blank label", { label: "   " }],
    ["a label over 60 characters", { label: "x".repeat(61) }],
    ["a label with a control character", { label: "Ven\u0007dor" }],
    ["a label over two lines", { label: "Vendor\nVadim" }],
    ["an empty identifier", { identifier: "" }],
    ["an identifier over 200 characters", { identifier: "x".repeat(201) }],
    ["an empty password", { password: "" }],
    ["a password over 500 characters", { password: "x".repeat(501) }],
    ["a numeric password", { password: 1234 }],
    ["a numeric key", { totp: 123_456 }],
    ["no origin", { origin: undefined }],
  ])("refuses %s with invalid_request", async (_case, fields) => {
    const response = await call(
      postLogin(loginRequest(teemiqToken, validLogin(fields)))
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
    await expect(listVaultItems(owner)).resolves.toEqual([]);
  });

  it.each([
    ["an empty body", ""],
    ["a body that is not JSON", "{"],
    ["a JSON array", "[]"],
  ])("refuses %s with invalid_request", async (_case, body) => {
    const response = await call(
      postLogin(
        new Request("https://assist.example/api/site/logins", {
          body,
          headers: { authorization: `Bearer ${teemiqToken}` },
          method: "POST",
        })
      )
    );

    expect(response.status).toBe(400);
  });

  it("refuses a body over the cap before reading it", async () => {
    const response = await call(
      postLogin(
        new Request("https://assist.example/api/site/logins", {
          body: JSON.stringify(validLogin({})),
          headers: {
            authorization: `Bearer ${teemiqToken}`,
            "content-length": String(64 * 1024),
          },
          method: "POST",
        })
      )
    );

    expect(response.status).toBe(400);
    await expect(listVaultItems(owner)).resolves.toEqual([]);
  });

  it("accepts each field at its longest", async () => {
    const response = await call(
      postLogin(
        loginRequest(teemiqToken, {
          identifier: "x".repeat(200),
          label: "x".repeat(60),
          origin: "https://login.vendor.example",
          password: "x".repeat(500),
        })
      )
    );

    expect(response.status).toBe(201);
  });

  it("answers 409 duplicate_label for a second login of the label in any case, also when both arrive at once", async () => {
    const first = await call(
      postLogin(loginRequest(teemiqToken, validLogin({ label: "Vendor" })))
    );
    const again = await call(
      postLogin(loginRequest(teemiqToken, validLogin({ label: "vENDOR " })))
    );
    const otherSite = await call(
      postLogin(loginRequest(agentsToken, validLogin({ label: "Vendor" })))
    );
    const together = await Promise.all(
      [1, 2].map(async () =>
        call(
          postLogin(loginRequest(teemiqToken, validLogin({ label: "Same" })))
        )
      )
    );

    expect(first.status).toBe(201);
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toEqual({ error: "duplicate_label" });
    expect(otherSite.status).toBe(201);
    expect(
      together
        .map(({ status }) => status)
        .toSorted((left, right) => left - right)
    ).toEqual([201, 409]);
    expect(
      (await listVaultItems(owner)).map(({ label, site }) => [site, label])
    ).toHaveLength(3);
  });

  it("answers 503 without detail when the vault cannot be written", async () => {
    // The owner lookup reads the database first; the save's next read fails.
    const failing = new Error(`Failed query: insert params ${password}`);
    vi.spyOn(Database, "db", "get")
      .mockReturnValueOnce(testDatabase)
      .mockImplementationOnce(() => {
        throw failing;
      });

    const response = await call(
      postLogin(loginRequest(teemiqToken, validLogin({})))
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
    expect(console.warn).toHaveBeenCalledWith(
      "[site] login could not be saved",
      {
        error: "Error",
        site: "teemiq",
      }
    );
  });
});

describe("GET /api/site/logins", () => {
  it("lists only the logins this site saved, newest first", async () => {
    await saveVaultItem(owner, ownLogin());
    const older = await saveLogin(teemiqToken, validLogin({ label: "Older" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await saveLogin(
      teemiqToken,
      validLogin({ label: "Newer", totp: totpSecret })
    );
    const agents = await saveLogin(
      agentsToken,
      validLogin({ label: "Agents" })
    );

    const response = await call(listLogins(siteRequest(teemiqToken)));
    const agentsResponse = await call(listLogins(siteRequest(agentsToken)));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      logins: [
        { ...newer, hasTotp: true },
        { ...older, hasTotp: false },
      ],
    });
    await expect(agentsResponse.json()).resolves.toEqual({ logins: [agents] });
  });

  it("lists nothing for a site that saved nothing", async () => {
    await saveVaultItem(owner, ownLogin());

    const response = await call(listLogins(siteRequest(agentsToken)));

    await expect(response.json()).resolves.toEqual({ logins: [] });
  });
});

describe("DELETE /api/site/logins/{loginId}", () => {
  it("removes the site's login and its browser profile", async () => {
    const { loginId } = await saveLogin(teemiqToken, validLogin({}));

    const response = await call(
      removeLogin(...deleteRequest(teemiqToken, loginId))
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("");
    await expect(listVaultItems(owner)).resolves.toEqual([]);
    await expect(readVaultSecret(owner, loginId)).resolves.toBeUndefined();
    expect(kernel.deleteProfile).toHaveBeenCalledExactlyOnceWith(
      kernelProfileNameForLogin(owner.workspaceId, loginId),
      expect.anything()
    );
  });

  it("answers 404 for the owner's own login, another site's, an unknown id and a non-id, removing nothing", async () => {
    await saveVaultItem(owner, ownLogin());
    const [own] = await listVaultItems(owner);
    const { loginId: agentsLogin } = await saveLogin(
      agentsToken,
      validLogin({})
    );

    const responses = await Promise.all(
      [
        own?.id ?? "",
        agentsLogin,
        "00000000-0000-4000-8000-00000000abcd",
        "login-1",
      ].map(async (id) => call(removeLogin(...deleteRequest(teemiqToken, id))))
    );

    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404, 404]);
    await expect(responses[0]?.json()).resolves.toEqual({ error: "not_found" });
    await expect(listVaultItems(owner)).resolves.toHaveLength(2);
    expect(kernel.deleteProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["runs", () => runningTask()],
    ["waits for a code", () => awaitingCode()],
    ["has just been accepted by eve", () => new ClientError(404, "{}")],
  ])(
    "answers 409 login_busy while a task pinned to the login %s",
    async (_case, state) => {
      const { loginId } = await saveLogin(teemiqToken, validLogin({}));
      await recordSiteTask("teemiq", owner, "wrun_busy", loginId);
      const events = state();
      eve.read.mockImplementation(async () => {
        if (events instanceof Error) throw events;
        return events;
      });

      const response = await call(
        removeLogin(...deleteRequest(teemiqToken, loginId))
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "login_busy" });
      expect(eve.read).toHaveBeenCalledExactlyOnceWith("wrun_busy");
      await expect(listVaultItems(owner)).resolves.toHaveLength(1);
      expect(kernel.deleteProfile).not.toHaveBeenCalled();
    }
  );

  it("removes a login whose tasks finished, belong to another site or are past their lifetime", async () => {
    const { loginId } = await saveLogin(teemiqToken, validLogin({}));
    await recordSiteTask("teemiq", owner, "wrun_done", loginId);
    await recordSiteTask("agents", owner, "wrun_agents", loginId);
    const old = await recordSiteTask("teemiq", owner, "wrun_old", loginId);
    await database
      .update(schema.siteTasks)
      .set({ createdAt: new Date(Date.now() - 46 * 60_000) })
      .where(eq(schema.siteTasks.id, old));
    eve.read.mockImplementation(async (sessionId) =>
      sessionId === "wrun_done" ? completedTask() : runningTask()
    );

    const response = await call(
      removeLogin(...deleteRequest(teemiqToken, loginId))
    );

    expect(response.status).toBe(204);
    expect(eve.read).toHaveBeenCalledExactlyOnceWith("wrun_done");
  });

  it("answers 503 and keeps the login while eve cannot say whether its task is open", async () => {
    const { loginId } = await saveLogin(teemiqToken, validLogin({}));
    await recordSiteTask("teemiq", owner, "wrun_unknown", loginId);
    eve.read.mockRejectedValue(new ClientError(500, "{}"));

    const response = await call(
      removeLogin(...deleteRequest(teemiqToken, loginId))
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
    await expect(listVaultItems(owner)).resolves.toHaveLength(1);
  });
});

describe("POST /api/site/tasks with a saved login", () => {
  it("pins a task only to a login this site saved", async () => {
    await saveVaultItem(owner, ownLogin());
    const [own] = await listVaultItems(owner);
    const { loginId } = await saveLogin(
      teemiqToken,
      validLogin({ origin: "https://login.vendor.example/sign-in" })
    );
    const { loginId: agentsLogin } = await saveLogin(
      agentsToken,
      validLogin({})
    );

    const refused = await Promise.all(
      [
        [teemiqToken, own?.id ?? ""],
        [teemiqToken, agentsLogin],
        [agentsToken, loginId],
      ].map(async ([token = "", id = ""]) =>
        call(createTask(taskRequest(token, id)))
      )
    );
    const pinned = await call(createTask(taskRequest(teemiqToken, loginId)));

    expect(refused.map(({ status }) => status)).toEqual([400, 400, 400]);
    await expect(
      Promise.all(refused.map((response) => response.json()))
    ).resolves.toEqual([
      { error: "invalid_request" },
      { error: "invalid_request" },
      { error: "invalid_request" },
    ]);
    expect(pinned.status).toBe(202);
    expect(eve.create).toHaveBeenCalledOnce();
    const bearer = eve.bearers.at(-1);
    expect(verifySiteCredential(authSecret, (await bearer?.()) ?? "")).toEqual({
      login: { id: loginId, origin: "https://login.vendor.example" },
      op: "create",
      site: "teemiq",
    });
    expect(
      await database
        .select({ loginId: schema.siteTasks.loginId })
        .from(schema.siteTasks)
    ).toEqual([{ loginId }]);
  });
});

describe("site login authentication", () => {
  it("refuses a wrong token with 401 on every login route", async () => {
    const wrong = "not-a-configured-site-token-0123456789";

    const responses = await Promise.all([
      call(postLogin(loginRequest(wrong, validLogin({})))),
      call(listLogins(siteRequest(wrong))),
      call(
        removeLogin(
          ...deleteRequest(wrong, "00000000-0000-4000-8000-000000000001")
        )
      ),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401]);
    expect(
      responses.map((response) => response.headers.get("cache-control"))
    ).toEqual(["no-store", "no-store", "no-store"]);
    await expect(
      Promise.all(responses.map((response) => response.json()))
    ).resolves.toEqual([
      { error: "unauthorized" },
      { error: "unauthorized" },
      { error: "unauthorized" },
    ]);
    await expect(listVaultItems(owner)).resolves.toEqual([]);
  });

  it("refuses every login route with 403 while the owner cannot sign in", async () => {
    vi.stubEnv("ASSIST_SITE_OWNER_TEEMIQ", "nobody@example.test");

    const responses = await Promise.all([
      call(postLogin(loginRequest(teemiqToken, validLogin({})))),
      call(listLogins(siteRequest(teemiqToken))),
      call(
        removeLogin(
          ...deleteRequest(teemiqToken, "00000000-0000-4000-8000-000000000001")
        )
      ),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([403, 403, 403]);
    await expect(listVaultItems(owner)).resolves.toEqual([]);
  });
});

// Records the answer's text for the secrets check, and hands back a copy.
async function call(pending: Promise<Response>) {
  const response = await pending;
  answers.push(await response.clone().text());
  return response;
}

async function saveLogin(token: string, body: LoginBody) {
  const response = await call(postLogin(loginRequest(token, body)));
  if (response.status !== 201) throw new Error("The login was not saved.");
  return loginOf(response);
}

// A saved login's answer, holding exactly the fields the contract names.
async function loginOf(response: Response) {
  return z
    .strictObject({
      login: z.strictObject({
        createdAt: z.string(),
        hasTotp: z.boolean(),
        label: z.string(),
        loginId: z.string(),
        origin: z.string(),
      }),
    })
    .parse(await response.json()).login;
}

// A request body as a site sends it, valid or not.
type LoginBody = Readonly<Record<string, z.core.util.JSONType | undefined>>;

function validLogin(fields: LoginBody) {
  return {
    identifier,
    label: "Vendor",
    origin: "https://login.vendor.example",
    password,
    ...fields,
  };
}

function ownLogin() {
  return {
    account: "",
    kind: "login" as const,
    label: "Vendor",
    secret: serializeLoginVaultPayload({
      authentication: { password, type: "password" },
      identifier: { type: "email", value: identifier },
      kind: "login",
      origin: "https://login.vendor.example",
      version: 2,
    }),
  };
}

function loginRequest(token: string, body: LoginBody) {
  return new Request("https://assist.example/api/site/logins", {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}` },
    method: "POST",
  });
}

function siteRequest(token: string) {
  return new Request("https://assist.example/api/site/logins", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function deleteRequest(token: string, loginId: string) {
  return [
    new Request(`https://assist.example/api/site/logins/${loginId}`, {
      headers: { authorization: `Bearer ${token}` },
      method: "DELETE",
    }),
    { params: Promise.resolve({ loginId }) },
  ] as const;
}

function taskRequest(token: string, loginId: string) {
  return new Request("https://assist.example/api/site/tasks", {
    body: JSON.stringify({ loginId, message: "Fetch the October invoice." }),
    headers: { authorization: `Bearer ${token}` },
    method: "POST",
  });
}

const turnStarted: Fact = {
  data: { cause: { deliveryId: "d-1" }, follows: null, turnId: "turn_0" },
  type: "turn.started",
};

function runningTask() {
  return eventsOf([[turnStarted]]);
}

function awaitingCode() {
  return eventsOf([
    [turnStarted],
    [
      {
        data: {
          interactionId: "interaction-1",
          request: {
            allowFreeform: true,
            display: "text",
            kind: "question",
            prompt:
              'Enter the one-time code that login.vendor.example just sent by email for the saved login "Vendor".',
            title: "One-time code",
          },
          subject: { turnId: "turn_0" },
        },
        scope: { turnId: "turn_0" },
        type: "interaction.opened",
      },
      {
        data: {
          awaiting: [{ interactionId: "interaction-1" }],
          turnId: "turn_0",
        },
        scope: { turnId: "turn_0" },
        type: "turn.paused",
      },
    ],
  ]);
}

function completedTask() {
  return eventsOf([
    [turnStarted],
    [
      {
        data: { outcome: "completed", turnId: "turn_0" },
        scope: { turnId: "turn_0" },
        type: "turn.settled",
      },
    ],
  ]);
}
