import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as Database from "@db";
import type { getAuth } from "@db/services/auth";
import type * as SessionReaders from "@db/services/auth/session";
import * as schema from "../../../schema";

const signupCode = vi.hoisted(() => {
  const code = "team-signup-code-0123456789";
  // The environment module validates once on import, so stub before imports.
  vi.stubEnv(
    "ASSIST_ALLOWED_EMAILS",
    [
      "Alice@Example.test",
      "bob@example.test",
      "dave@example.test",
      "erin@example.test",
      "frank@example.test",
      "grace@example.test",
    ].join(", ")
  );
  vi.stubEnv("ASSIST_SIGNUP_CODE", code);
  return code;
});

const origin = "https://example.com";
const password = "correct horse battery staple";

// One database and one Better Auth instance serve the whole file; each case
// uses its own team member.
let database: PGlite;
let auth: Awaited<ReturnType<typeof getAuth>>;
let session: typeof SessionReaders;

beforeAll(async () => {
  database = new PGlite();
  const journal = z
    .object({ entries: z.array(z.object({ tag: z.string() })) })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../../../migrations/meta/_journal.json", import.meta.url),
          "utf8"
        )
      )
    );
  /* oxlint-disable eslint/no-await-in-loop -- Migrations must execute in journal order. */
  for (const { tag } of journal.entries) {
    const migration = await readFile(
      new URL(`../../../migrations/${tag}.sql`, import.meta.url),
      "utf8"
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
  const pgliteDatabase = drizzle(database, { schema });
  // SAFETY: PGlite implements the query-builder surface Better Auth's Drizzle adapter uses, with the shared schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The focused test swaps only the database driver.
  vi.spyOn(Database, "db", "get").mockReturnValue(pgliteDatabase as never);
  const [authModule, sessionModule] = await Promise.all([
    import("@db/services/auth"),
    import("@db/services/auth/session"),
  ]);
  auth = await authModule.getAuth();
  session = sessionModule;
}, 30_000);

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await database.close();
});

describe("team sign-in", () => {
  it("admits a listed email only after its authenticator is enrolled and verified", async () => {
    const client = authClient();

    const created = await client.post("/sign-up/email", {
      email: "ALICE@example.TEST",
      name: "Alice",
      password,
      signupCode,
    });
    expect(created.status).toBe(200);
    expect(client.cookie("session_token")).toBeUndefined();

    // A password alone opens a session that only the setup page accepts.
    expect(
      (
        await client.post("/sign-in/email", {
          email: "alice@EXAMPLE.test",
          password,
        })
      ).status
    ).toBe(200);
    expect(await session.getAuthSession(client.headers())).toBeNull();
    expect(await session.getTwoFactorSetupSession(client.headers())).toEqual({
      email: "alice@example.test",
      enrolled: false,
    });

    const enable = await client.post("/two-factor/enable", { password });
    expect(enable.status).toBe(200);
    const { backupCodes, totpURI } = enrolmentSchema.parse(enable.json);
    expect(totpURI).toContain("issuer=iCommAssist");
    expect(await session.getAuthSession(client.headers())).toBeNull();

    expect(
      (await client.post("/two-factor/verify-totp", { code: "000000" })).status
    ).toBe(401);
    expect(
      (await client.post("/two-factor/verify-totp", { code: totp(totpURI) }))
        .status
    ).toBe(200);
    expect(await session.getAuthSession(client.headers())).toMatchObject({
      user: { email: "alice@example.test", twoFactorEnabled: true },
    });
    expect(await session.getTwoFactorSetupSession(client.headers())).toBeNull();

    // Later sign-ins hold no session until the second factor succeeds.
    await client.post("/sign-out", {});
    const signIn = await client.post("/sign-in/email", {
      email: "alice@example.test",
      password,
    });
    expect(signIn.json).toMatchObject({ twoFactorRedirect: true });
    expect(client.cookie("session_token")).toBeUndefined();
    expect(await session.getAuthSession(client.headers())).toBeNull();
    expect(
      (await client.post("/two-factor/verify-totp", { code: totp(totpURI) }))
        .status
    ).toBe(200);
    expect(await session.getAuthSession(client.headers())).not.toBeNull();

    // A backup code works once in place of the authenticator.
    const backupCode = z.string().parse(backupCodes[0]);
    await client.post("/sign-out", {});
    await client.post("/sign-in/email", {
      email: "alice@example.test",
      password,
    });
    expect(
      (
        await client.post("/two-factor/verify-backup-code", {
          code: backupCode,
        })
      ).status
    ).toBe(200);
    expect(await session.getAuthSession(client.headers())).not.toBeNull();
    await client.post("/sign-out", {});
    await client.post("/sign-in/email", {
      email: "alice@example.test",
      password,
    });
    expect(
      (
        await client.post("/two-factor/verify-backup-code", {
          code: backupCode,
        })
      ).status
    ).toBe(401);
  }, 30_000);

  it.each([
    [
      "an unlisted email",
      { email: "carol@example.test", name: "Carol", password, signupCode },
    ],
    [
      "a wrong signup code",
      {
        email: "bob@example.test",
        name: "Bob",
        password,
        signupCode: "wrong-signup-code-0123456789",
      },
    ],
    [
      "a missing signup code",
      { email: "bob@example.test", name: "Bob", password },
    ],
  ])("refuses sign-up with %s using one answer", async (_case, body) => {
    const response = await authClient().post("/sign-up/email", body);

    expect(response.status).toBe(400);
    expect(response.json).toEqual({
      code: "SIGN_UP_REJECTED",
      message: "This email and signup code cannot create an account.",
    });
    expect(
      await database.query('SELECT id FROM "user" WHERE email = $1', [
        body.email,
      ])
    ).toMatchObject({ rows: [] });
  });

  it("gives a registered email the same answer for a wrong signup code", async () => {
    const client = authClient();
    await signUp(client, "dave@example.test");

    const response = await client.post("/sign-up/email", {
      email: "dave@example.test",
      name: "Dave",
      password,
      signupCode: "wrong-signup-code-0123456789",
    });

    expect(response.json).toMatchObject({ code: "SIGN_UP_REJECTED" });
  });

  it("does not let a password-only session opened before enrolment count afterwards", async () => {
    const client = authClient();
    const earlier = authClient();
    await signUp(client, "erin@example.test");
    await earlier.post("/sign-in/email", {
      email: "erin@example.test",
      password,
    });
    const totpURI = await enrol(client, "erin@example.test");

    await client.post("/two-factor/verify-totp", { code: totp(totpURI) });

    expect(await session.getAuthSession(client.headers())).not.toBeNull();
    expect(await session.getAuthSession(earlier.headers())).toBeNull();
    expect(await session.getTwoFactorSetupSession(earlier.headers())).toEqual({
      email: "erin@example.test",
      enrolled: true,
    });
  }, 30_000);

  it("refuses to trust a device past the second factor", async () => {
    const client = authClient();
    await signUp(client, "frank@example.test");
    const totpURI = await enrol(client, "frank@example.test");

    const response = await client.post("/two-factor/verify-totp", {
      code: totp(totpURI),
      trustDevice: true,
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ code: "TRUST_DEVICE_DISABLED" });
    expect(client.cookie("trust_device")).toBeUndefined();
  });

  it("ends access for an email that is no longer on the team list", async () => {
    const client = authClient();
    await signUp(client, "grace@example.test");
    const totpURI = await enrol(client, "grace@example.test");
    await client.post("/two-factor/verify-totp", { code: totp(totpURI) });
    expect(await session.getAuthSession(client.headers())).not.toBeNull();

    await database.query(`UPDATE "user" SET email = $1 WHERE email = $2`, [
      "removed@example.test",
      "grace@example.test",
    ]);

    expect(await session.getAuthSession(client.headers())).toBeNull();
    expect(await session.getTwoFactorSetupSession(client.headers())).toBeNull();
    const signIn = await client.post("/sign-in/email", {
      email: "removed@example.test",
      password,
    });
    expect(signIn.status).toBe(401);
    expect(signIn.json).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
  }, 30_000);

  it("limits sign-in, sign-up and second-factor attempts in production", () => {
    expect(auth.options.rateLimit.customRules).toMatchObject({
      "/sign-in/email": { max: 5, window: 60 },
      "/sign-up/email": { max: 5, window: 600 },
      "/two-factor/verify-backup-code": { max: 5, window: 60 },
      "/two-factor/verify-totp": { max: 5, window: 60 },
    });
    // Disabling IP tracking would turn rate limiting off entirely.
    expect(auth.options).not.toHaveProperty("advanced");
  });
});

const enrolmentSchema = z.object({
  backupCodes: z.array(z.string()).min(1),
  totpURI: z.string(),
});

async function signUp(client: ReturnType<typeof authClient>, email: string) {
  const response = await client.post("/sign-up/email", {
    email,
    name: email,
    password,
    signupCode,
  });
  expect(response.status).toBe(200);
}

// Signs in with the password and starts enrolment, returning the otpauth URI.
async function enrol(client: ReturnType<typeof authClient>, email: string) {
  await client.post("/sign-in/email", { email, password });
  return enrolmentSchema.parse(
    (await client.post("/two-factor/enable", { password })).json
  ).totpURI;
}

// A minimal browser: it keeps Better Auth's cookies and sends the trusted
// Origin, as a same-site page would.
function authClient() {
  const jar = new Map<string, string>();
  const headers = () => {
    const result = new Headers({ origin });
    if (jar.size > 0) {
      result.set(
        "cookie",
        [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
      );
    }
    return result;
  };
  return {
    cookie(suffix: string) {
      return [...jar].find(([name]) => name.endsWith(suffix))?.[1];
    },
    headers,
    async post(path: string, body: Record<string, string | boolean>) {
      const requestHeaders = headers();
      requestHeaders.set("content-type", "application/json");
      const response = await auth.handler(
        new Request(`${origin}/api/auth${path}`, {
          body: JSON.stringify(body),
          headers: requestHeaders,
          method: "POST",
        })
      );
      for (const cookie of response.headers.getSetCookie()) {
        const [pair = ""] = cookie.split(";");
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        if (!value || /max-age=0/iu.test(cookie)) jar.delete(name);
        else jar.set(name, value);
      }
      const text = await response.text();
      return {
        json: text ? z.json().parse(JSON.parse(text)) : null,
        status: response.status,
      };
    },
  };
}

// RFC 6238 with the otpauth defaults: SHA-1, 6 digits, 30-second steps.
function totp(uri: string) {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replace(/=+$/u, "").toUpperCase()) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(
    (bits.match(/.{8}/gu) ?? []).map((byte) => Number.parseInt(byte, 2))
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = (hmac.at(-1) ?? 0) & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0"
  );
}
