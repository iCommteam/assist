import { PGlite } from "@electric-sql/pglite";
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

// The environment module validates once on import, so stub before imports.
vi.hoisted(() => {
  vi.stubEnv(
    "ASSIST_ALLOWED_EMAILS",
    "alice@example.test, bob@example.test, carol@example.test"
  );
});

const {
  cancelWhatsappLinkCode,
  createWhatsappLinkCode,
  deleteWhatsappLink,
  linkWhatsappNumber,
  whatsappLinkById,
  whatsappLinkCodeLive,
  whatsappLinkLimited,
  whatsappLinkOf,
} = await import("@db/services/whatsapp-links");
const {
  connectedWhatsappNumbers,
  dropOverriddenWhatsappLink,
  whatsappEmailOf,
  whatsappNumbersOf,
  whatsappOwnerOf,
} = await import("@db/services/whatsapp-numbers");

const client = new PGlite();
const database = drizzle(client, { schema });
const firstPhone = "+15550000001";
const secondPhone = "+15550000002";

let sequence = 0;
function nextSid() {
  sequence += 1;
  return `SM${String(sequence).padStart(32, "0")}`;
}

function attempt(
  code: string,
  phone = firstPhone,
  listing?: { readonly email: string | undefined }
) {
  return linkWhatsappNumber({ code, listing, phone, sid: nextSid() });
}

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
  // Alice and Bob may use WhatsApp; Carol has no authenticator, and Dave is
  // not on the team list.
  await client.exec(`
    INSERT INTO "user" (id, name, email, "emailVerified", "twoFactorEnabled") VALUES
      ('alice', 'Alice', 'Alice@Example.test', true, true),
      ('bob', 'Bob', 'bob@example.test', true, true),
      ('carol', 'Carol', 'carol@example.test', true, false),
      ('dave', 'Dave', 'dave@example.test', true, true);
  `);
}, 20_000);

beforeEach(async () => {
  vi.stubEnv("ASSIST_WHATSAPP_NUMBERS", "");
  await client.exec(
    "TRUNCATE whatsapp_links, whatsapp_link_codes, whatsapp_link_failures"
  );
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("WhatsApp link codes", () => {
  it("makes eight characters with no 0, O, 1, I or L, and stores only a keyed hash of them", async () => {
    const { code, expiresAt } = await createWhatsappLinkCode("alice");

    expect(code).toMatch(/^[2-9ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/u);
    const minutes = (expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    const rows = await client.query<{ code_hash: string }>(
      "SELECT code_hash FROM whatsapp_link_codes"
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows.rows[0]?.code_hash).not.toContain(code);
    await expect(whatsappLinkCodeLive("alice")).resolves.toBe(true);
  });

  it("keeps one live code per member: a new one replaces the old", async () => {
    const first = await createWhatsappLinkCode("alice");
    const second = await createWhatsappLinkCode("alice");

    const count = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM whatsapp_link_codes"
    );
    expect(count.rows[0]?.count).toBe(1);
    await expect(attempt(first.code)).resolves.toEqual({
      lastTry: false,
      outcome: "failed",
    });
    await expect(attempt(second.code)).resolves.toMatchObject({
      outcome: "linked",
    });
  });

  it("links a number once, with the code read in any case", async () => {
    const { code } = await createWhatsappLinkCode("alice");

    await expect(attempt(code.toLowerCase())).resolves.toEqual({
      email: "alice@example.test",
      outcome: "linked",
      previousPhone: undefined,
      userId: "alice",
    });
    await expect(attempt(code, secondPhone)).resolves.toEqual({
      lastTry: false,
      outcome: "failed",
    });
    await expect(whatsappLinkOf("alice")).resolves.toMatchObject({
      phone: firstPhone,
    });
    await expect(whatsappLinkCodeLive("alice")).resolves.toBe(false);
  });

  it("refuses a code past its 10 minutes, and a cancelled one", async () => {
    const expired = await createWhatsappLinkCode("alice");
    await client.exec(
      "UPDATE whatsapp_link_codes SET expires_at = now() - interval '1 second'"
    );
    await expect(whatsappLinkCodeLive("alice")).resolves.toBe(false);
    await expect(attempt(expired.code)).resolves.toEqual({
      lastTry: false,
      outcome: "failed",
    });

    const cancelled = await createWhatsappLinkCode("bob");
    await cancelWhatsappLinkCode("bob");
    await expect(attempt(cancelled.code)).resolves.toEqual({
      lastTry: false,
      outcome: "failed",
    });
    await expect(whatsappLinkOf("alice")).resolves.toBeUndefined();
    await expect(whatsappLinkOf("bob")).resolves.toBeUndefined();
  });

  it("refuses a member without an authenticator or off the team list, and uses the code up", async () => {
    for (const userId of ["carol", "dave"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each member's code is made and tried in turn.
      const { code } = await createWhatsappLinkCode(userId);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each member's code is made and tried in turn.
      await expect(
        attempt(code, `+1555000010${String(userId.length)}`)
      ).resolves.toEqual({ lastTry: false, outcome: "failed" });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each member's code is made and tried in turn.
      await expect(whatsappLinkCodeLive(userId)).resolves.toBe(false);
    }
    const links = await client.query("SELECT * FROM whatsapp_links");
    expect(links.rows).toEqual([]);
  });
});

describe("WhatsApp link limits", () => {
  it("stops a number after 5 failed attempts in an hour, keeping the count and the code", async () => {
    const outcomes = [];
    for (let tried = 0; tried < 5; tried += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The attempts arrive one after another.
      outcomes.push(await attempt("ZZZZZZZZ"));
    }
    expect(outcomes).toEqual([
      ...Array.from({ length: 4 }, () => ({
        lastTry: false,
        outcome: "failed",
      })),
      { lastTry: true, outcome: "failed" },
    ]);
    const failures = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM whatsapp_link_failures"
    );
    expect(failures.rows[0]?.count).toBe(5);
    await expect(whatsappLinkLimited(firstPhone)).resolves.toBe(true);
    await expect(whatsappLinkLimited(secondPhone)).resolves.toBe(false);

    const { code } = await createWhatsappLinkCode("alice");
    await expect(attempt(code)).resolves.toEqual({ outcome: "limited" });
    await expect(whatsappLinkCodeLive("alice")).resolves.toBe(true);
    await expect(attempt(code, secondPhone)).resolves.toMatchObject({
      outcome: "linked",
    });
  });

  it("counts only the last hour", async () => {
    await client.exec(
      `INSERT INTO whatsapp_link_failures (sid, phone, failed_at)
       SELECT 'SM' || lpad(n::text, 32, 'f'), '${firstPhone}', now() - interval '61 minutes'
       FROM generate_series(1, 5) AS n`
    );
    const { code } = await createWhatsappLinkCode("alice");

    await expect(whatsappLinkLimited(firstPhone)).resolves.toBe(false);
    await expect(attempt(code)).resolves.toMatchObject({ outcome: "linked" });
  });

  it("past 50 failed attempts in an hour in all, answers no code that matches nothing, and still links a live one", async () => {
    await client.exec(
      `INSERT INTO whatsapp_link_failures (sid, phone)
       SELECT 'SM' || lpad(n::text, 32, 'e'), '+1555100' || lpad(n::text, 4, '0')
       FROM generate_series(1, 50) AS n`
    );

    await expect(attempt("ZZZZZZZZ")).resolves.toEqual({ outcome: "limited" });
    const fromFirst = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM whatsapp_link_failures WHERE phone = '${firstPhone}'`
    );
    expect(fromFirst.rows[0]?.count).toBe(1);

    const { code } = await createWhatsappLinkCode("alice");
    await expect(attempt(code, secondPhone)).resolves.toMatchObject({
      outcome: "linked",
    });
  });
});

describe("WhatsApp links", () => {
  it("gives a member one number: a new link replaces the old one and names it", async () => {
    await attempt((await createWhatsappLinkCode("alice")).code);
    const moved = await attempt(
      (await createWhatsappLinkCode("alice")).code,
      secondPhone
    );

    expect(moved).toMatchObject({
      outcome: "linked",
      previousPhone: firstPhone,
    });
    const links = await client.query<{ phone: string; user_id: string }>(
      "SELECT user_id, phone FROM whatsapp_links"
    );
    expect(links.rows).toEqual([{ phone: secondPhone, user_id: "alice" }]);
  });

  it("refuses a number linked to someone else, and tells its own member it is already connected", async () => {
    await attempt((await createWhatsappLinkCode("alice")).code);

    await expect(
      attempt((await createWhatsappLinkCode("bob")).code)
    ).resolves.toEqual({ lastTry: false, outcome: "taken" });
    await expect(
      attempt((await createWhatsappLinkCode("alice")).code)
    ).resolves.toEqual({ email: "alice@example.test", outcome: "already" });
    await expect(whatsappLinkOf("bob")).resolves.toBeUndefined();
    const failures = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM whatsapp_link_failures"
    );
    expect(failures.rows[0]?.count).toBe(1);
  });

  it("never links a number ASSIST_WHATSAPP_NUMBERS lists", async () => {
    await expect(
      attempt((await createWhatsappLinkCode("alice")).code, firstPhone, {
        email: "alice@example.test",
      })
    ).resolves.toEqual({ email: "alice@example.test", outcome: "already" });
    await expect(
      attempt((await createWhatsappLinkCode("bob")).code, firstPhone, {
        email: "alice@example.test",
      })
    ).resolves.toEqual({ lastTry: false, outcome: "server" });
    const links = await client.query("SELECT * FROM whatsapp_links");
    expect(links.rows).toEqual([]);
  });

  it("deletes a link only for its own member, and with the member's row", async () => {
    await attempt((await createWhatsappLinkCode("bob")).code);
    const link = await whatsappLinkOf("bob");
    if (!link) throw new Error("Bob's number was not linked.");

    await expect(whatsappLinkById(link.id)).resolves.toMatchObject({
      phone: firstPhone,
      userId: "bob",
    });
    await expect(deleteWhatsappLink(link.id, "alice")).resolves.toBeUndefined();
    await expect(deleteWhatsappLink(link.id, "bob")).resolves.toEqual({
      phone: firstPhone,
    });
    await expect(whatsappLinkById(link.id)).resolves.toBeUndefined();

    await attempt((await createWhatsappLinkCode("bob")).code);
    await client.exec(`DELETE FROM "user" WHERE id = 'bob'`);
    await expect(whatsappLinkOf("bob")).resolves.toBeUndefined();
    await client.exec(`
      INSERT INTO "user" (id, name, email, "emailVerified", "twoFactorEnabled")
      VALUES ('bob', 'Bob', 'bob@example.test', true, true);
    `);
  });
});

describe("who a WhatsApp number reaches", () => {
  it("reads a linked number as its member's, in lower case", async () => {
    await attempt((await createWhatsappLinkCode("alice")).code);

    await expect(whatsappOwnerOf(firstPhone)).resolves.toEqual({
      email: "alice@example.test",
      source: "linked",
    });
    await expect(whatsappEmailOf(secondPhone)).resolves.toBeUndefined();
    await expect(whatsappNumbersOf("ALICE@example.test")).resolves.toEqual([
      expect.objectContaining({ number: firstPhone, source: "linked" }),
    ]);
  });

  it("puts ASSIST_WHATSAPP_NUMBERS first: a listed number reaches its listed email, and a link for it is ignored", async () => {
    await attempt((await createWhatsappLinkCode("alice")).code);
    vi.stubEnv(
      "ASSIST_WHATSAPP_NUMBERS",
      `${firstPhone}=bob@example.test,${secondPhone}=alice@example.test`
    );

    await expect(whatsappOwnerOf(firstPhone)).resolves.toEqual({
      email: "bob@example.test",
      source: "server",
    });
    await expect(whatsappNumbersOf("alice@example.test")).resolves.toEqual([
      { id: null, linkedAt: null, number: secondPhone, source: "server" },
    ]);
    await expect(connectedWhatsappNumbers()).resolves.toEqual([
      expect.objectContaining({
        email: "bob@example.test",
        number: firstPhone,
        source: "server",
      }),
      expect.objectContaining({
        email: "alice@example.test",
        number: secondPhone,
        source: "server",
      }),
    ]);

    vi.stubEnv(
      "ASSIST_WHATSAPP_NUMBERS",
      `${firstPhone}=bob@example.test,${firstPhone}=carol@example.test`
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(whatsappOwnerOf(firstPhone)).resolves.toEqual({
      email: undefined,
      source: "server",
    });
    await expect(connectedWhatsappNumbers()).resolves.toEqual([]);
  });

  it.each([
    [
      "a message from the number",
      async () => dropOverriddenWhatsappLink(firstPhone),
    ],
    [
      "the member's Workspace page",
      async () => whatsappNumbersOf("alice@example.test"),
    ],
    [
      "an administrator's Workspace page",
      async () => connectedWhatsappNumbers(),
    ],
  ])(
    "deletes a link to a number the list gives to someone else on %s, so it does not come back once the entry goes",
    async (_case, meet) => {
      await attempt((await createWhatsappLinkCode("alice")).code);
      vi.stubEnv("ASSIST_WHATSAPP_NUMBERS", `${firstPhone}=bob@example.test`);

      await meet();
      vi.stubEnv("ASSIST_WHATSAPP_NUMBERS", "");

      await expect(whatsappOwnerOf(firstPhone)).resolves.toBeUndefined();
      await expect(whatsappLinkOf("alice")).resolves.toBeUndefined();
    }
  );

  it("deletes a link to a number listed for two emails, its member's among them", async () => {
    await attempt((await createWhatsappLinkCode("alice")).code);
    vi.stubEnv(
      "ASSIST_WHATSAPP_NUMBERS",
      `${firstPhone}=alice@example.test,${firstPhone}=bob@example.test`
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await dropOverriddenWhatsappLink(firstPhone);

    await expect(whatsappLinkOf("alice")).resolves.toBeUndefined();
  });

  it("keeps a member's own link to a number the list gives them, which counts again once the entry goes", async () => {
    await attempt((await createWhatsappLinkCode("alice")).code);
    vi.stubEnv("ASSIST_WHATSAPP_NUMBERS", `${firstPhone}=Alice@example.test`);

    await dropOverriddenWhatsappLink(firstPhone);
    await expect(whatsappNumbersOf("alice@example.test")).resolves.toEqual([
      { id: null, linkedAt: null, number: firstPhone, source: "server" },
    ]);
    await connectedWhatsappNumbers();
    vi.stubEnv("ASSIST_WHATSAPP_NUMBERS", "");

    await expect(whatsappOwnerOf(firstPhone)).resolves.toEqual({
      email: "alice@example.test",
      source: "linked",
    });
  });

  it("lists a member's listed numbers before the one they linked", async () => {
    vi.stubEnv("ASSIST_WHATSAPP_NUMBERS", `${secondPhone}=alice@example.test`);
    await attempt((await createWhatsappLinkCode("alice")).code);

    const numbers = await whatsappNumbersOf("alice@example.test");
    expect(numbers.map(({ number, source }) => [number, source])).toEqual([
      [secondPhone, "server"],
      [firstPhone, "linked"],
    ]);
    await expect(connectedWhatsappNumbers()).resolves.toEqual([
      expect.objectContaining({ number: secondPhone, source: "server" }),
      expect.objectContaining({
        email: "alice@example.test",
        number: firstPhone,
        source: "linked",
      }),
    ]);
  });
});
