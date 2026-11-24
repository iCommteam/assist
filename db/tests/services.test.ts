import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Database from "@db";
import * as schema from "../schema";
import {
  browserTraceDomains as browserTraceDomainsTable,
  browserTraces as browserTracesTable,
} from "../schema";

const databases: PGlite[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("database services", () => {
  it("preserves workspace ownership across application domains", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);
    await applyBrowserImageMigration(client);
    await applyBrowserTraceMigration(client);
    await applyBrowserTraceEventMigration(client);
    await applySchemaAdoptionMigration(client);
    await applyNativeTypesMigration(client);
    await applyChatChannelMigration(client);
    await applySiteMigrations(client);

    const pgliteDatabase = drizzle(client, { schema });
    // SAFETY: PGlite implements the query-builder surface exercised by these services despite using a different Drizzle driver.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
    const database = pgliteDatabase as never;
    vi.spyOn(Database, "db", "get").mockReturnValue(database);

    const [browsers, browserTraces, chats, secrets, sessions, scope, vault] =
      await Promise.all([
        import("@db/services/browsers"),
        import("@db/services/browser-traces"),
        import("@db/services/chats"),
        import("@db/services/secrets"),
        import("@db/services/sessions"),
        import("@db/services/scope"),
        import("@db/services/vault"),
      ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };

    await scope.ensureScope(alice);
    await scope.ensureScope(bob);

    await sessions.claimSession(alice, "session-alice");

    expect(await sessions.isSessionOwned(alice, "session-alice")).toBe(true);
    expect(await sessions.isSessionOwned(bob, "session-alice")).toBe(false);

    await sessions.claimSession(alice, "session-imessage");
    expect(await chats.listChats(alice)).toEqual([]);

    await sessions.claimSession(bob, "session-alice");
    expect(await sessions.isSessionOwned(alice, "session-alice")).toBe(true);
    expect(await sessions.isSessionOwned(bob, "session-alice")).toBe(false);

    await chats.saveChat(alice, {
      channel: "http",
      sessionId: "session-alice",
      title: "Initial title",
      usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 4 },
    });
    await chats.saveChat(alice, {
      sessionId: "session-alice",
      title: "Updated title",
    });
    await chats.saveChat(alice, {
      channel: "channel:linq",
      sessionId: "session-imessage",
    });

    const aliceChat = await chats.readChat(alice, "session-alice");
    expect(aliceChat?.title).toBe("Updated title");
    expect(aliceChat?.channel).toBe("http");
    expect(aliceChat?.usage).toEqual({
      costUsd: 0.25,
      inputTokens: 10,
      outputTokens: 4,
    });
    expect(await chats.readChat(bob, "session-alice")).toBeUndefined();
    const indexedChats = await chats.listChats(alice);
    expect(indexedChats).toHaveLength(2);
    expect(
      indexedChats.find((chat) => chat.sessionId === "session-alice")
    ).toEqual(aliceChat);
    expect(
      indexedChats.find((chat) => chat.sessionId === "session-imessage")
    ).toMatchObject({ channel: "channel:linq", title: "New chat" });
    expect(await chats.listChats(bob)).toEqual([]);

    await chats.saveChat(bob, {
      sessionId: "session-alice",
      title: "Bob's title",
    });
    await chats.saveChat(bob, { sessionId: "session-unknown", title: "Probe" });
    expect(await chats.readChat(alice, "session-alice")).toEqual(aliceChat);
    expect(await chats.readChat(bob, "session-alice")).toBeUndefined();
    expect(await chats.readChat(bob, "session-unknown")).toBeUndefined();
    expect(await chats.listChats(bob)).toEqual([]);

    await browsers.createBrowserSession(alice, {
      createdAt: new Date().toISOString(),
      sessionId: "browser-alice",
      workerSessionId: "worker-alice",
    });
    expect(
      await browsers.readBrowserSession(alice, "browser-alice")
    ).toMatchObject({ workerSessionId: "worker-alice" });
    expect(
      await browsers.readBrowserSession(bob, "browser-alice")
    ).toBeUndefined();
    expect(
      await browsers.listWorkerBrowserSessions(alice, "worker-alice")
    ).toHaveLength(1);
    expect(
      await browsers.listWorkerBrowserSessions(bob, "worker-alice")
    ).toEqual([]);
    expect(
      await browsers.listWorkerBrowserSessions(alice, "worker-other")
    ).toEqual([]);
    expect(await browsers.deleteBrowserSession(bob, "browser-alice")).toBe(
      false
    );

    const { serializeLoginVaultPayload } = await import("@shared/vault/schema");
    await browserTraces.beginBrowserTrace(alice, {
      sessionId: "worker-alice",
      startedAt: "2026-08-31T00:00:00.000Z",
      task: "Order the blue mug",
    });
    await browserTraces.recordBrowserTraceDomains(alice, "worker-alice", [
      "shop.example.com",
      "shop.example.com",
    ]);
    await browserTraces.recordBrowserTraceDomains(bob, "worker-alice", [
      "intruder.example.com",
    ]);
    await browserTraces.completeBrowserTrace(alice, "worker-alice", {
      completedAt: "2026-08-31T00:00:12.500Z",
      resultMessage: "Ordered.",
      status: "success",
    });
    const [trace] = await pgliteDatabase
      .select()
      .from(browserTracesTable)
      .where(eq(browserTracesTable.sessionId, "worker-alice"));
    expect(trace).toMatchObject({
      durationMs: 12_500,
      resultMessage: "Ordered.",
      status: "success",
      task: "Order the blue mug",
    });
    const traceDomains = await pgliteDatabase
      .select()
      .from(browserTraceDomainsTable);
    expect(traceDomains).toHaveLength(1);
    expect(traceDomains[0]).toMatchObject({
      domain: "shop.example.com",
      traceSessionId: "worker-alice",
    });

    await browserTraces.recordBrowserTraceEvents(alice, "worker-alice", [
      {
        at: "2026-08-31T00:00:01.000Z",
        detail: "Order the blue mug",
        id: "evt_01",
        label: "Task received",
        type: "delivery.consumed",
      },
    ]);
    await browserTraces.recordBrowserTraceEvents(bob, "worker-alice", [
      {
        at: "2026-08-31T00:00:01.000Z",
        detail: "intrusion",
        id: "evt_02",
        label: "Task received",
        type: "delivery.consumed",
      },
    ]);
    const events = await browserTraces.listBrowserTraceEvents(
      alice,
      "worker-alice"
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "evt_01", label: "Task received" });
    expect(
      await browserTraces.listBrowserTraceEvents(bob, "worker-alice")
    ).toEqual([]);

    const tracePage = await browserTraces.listBrowserTraces(alice);
    expect(tracePage.nextCursor).toBeNull();
    expect(tracePage.traces).toHaveLength(1);
    expect(tracePage.traces[0]).toMatchObject({
      domains: ["shop.example.com"],
      durationMs: 12_500,
      sessionId: "worker-alice",
      status: "success",
      task: "Order the blue mug",
    });
    expect((await browserTraces.listBrowserTraces(bob)).traces).toEqual([]);

    await vault.saveVaultItem(alice, {
      account: "alice@example.com",
      kind: "login",
      label: "Alice",
      secret: serializeLoginVaultPayload({
        authentication: { password: "correct horse", type: "password" },
        identifier: { type: "email", value: "alice@example.com" },
        kind: "login",
        origin: "https://example.com",
        version: 2,
      }),
    });
    const [aliceVaultItem] = await vault.listVaultItems(alice);
    expect(aliceVaultItem).toMatchObject({
      label: "Alice",
    });
    expect(
      await vault.readVaultItem(bob, aliceVaultItem?.id ?? "vault-alice")
    ).toBeUndefined();
    expect(await vault.listVaultItems(alice)).toHaveLength(1);
    expect(
      await vault.deleteVaultItem(bob, aliceVaultItem?.id ?? "vault-alice")
    ).toBe(false);

    // A site task may be pinned only to a login that site saved, bound to a
    // website; the owner's own logins carry no site.
    const aliceLoginId = aliceVaultItem?.id ?? "vault-alice";
    expect(aliceVaultItem?.site).toBeNull();
    expect(
      await vault.readSiteLoginPin(alice, "teemiq", aliceLoginId)
    ).toBeUndefined();
    const siteLogin = await vault.saveSiteLogin(alice, "teemiq", {
      account: "",
      kind: "login",
      label: "Vendor",
      secret: serializeLoginVaultPayload({
        authentication: { password: "correct horse", type: "password" },
        identifier: { type: "email", value: "alice@example.com" },
        kind: "login",
        origin: "https://login.vendor.example",
        version: 2,
      }),
    });
    expect(await vault.readSiteLoginPin(alice, "teemiq", siteLogin.id)).toEqual(
      {
        alsoHosts: [],
        id: siteLogin.id,
        origin: "https://login.vendor.example",
      }
    );
    expect(
      await vault.readSiteLoginPin(alice, "agents", siteLogin.id)
    ).toBeUndefined();
    expect(
      await vault.readSiteLoginPin(bob, "teemiq", siteLogin.id)
    ).toBeUndefined();
    expect(
      await vault.readSiteLoginPin(alice, "teemiq", "vault-unknown")
    ).toBeUndefined();
    expect(await vault.readVaultItem(alice, siteLogin.id)).toMatchObject({
      site: "teemiq",
    });
    await vault.deleteVaultItem(alice, siteLogin.id);
    await vault.saveVaultItem(alice, {
      account: "",
      kind: "login",
      label: "Legacy",
      secret: JSON.stringify({
        authentication: { password: "correct horse", type: "password" },
        identifier: { type: "username", value: "alice" },
        kind: "login",
        version: 1,
      }),
    });
    await vault.saveVaultItem(alice, {
      account: "",
      kind: "address",
      label: "Home",
      secret: JSON.stringify({
        city: "Springfield",
        countryCode: "US",
        kind: "address",
        line1: "1 Main St",
        postalCode: "12345",
        recipientName: "Alice",
        region: "IL",
        version: 1,
      }),
    });
    const unbound = (await vault.listVaultItems(alice)).filter(
      ({ label }) => label !== "Alice"
    );
    expect(unbound).toHaveLength(2);
    expect(
      await Promise.all(
        unbound.map(({ id }) => vault.readSiteLoginPin(alice, "teemiq", id))
      )
    ).toEqual([undefined, undefined]);
    await Promise.all(
      unbound.map(({ id }) => vault.deleteVaultItem(alice, id))
    );

    const sharedSecretId = "00000000-0000-4000-8000-000000000099";
    await secrets.writeEncryptedSecret(
      alice,
      sharedSecretId,
      "ciphertext-alice"
    );
    await secrets.writeEncryptedSecret(bob, sharedSecretId, "ciphertext-bob");
    expect(await secrets.readEncryptedSecret(alice, sharedSecretId)).toBe(
      "ciphertext-alice"
    );
    expect(await secrets.readEncryptedSecret(bob, sharedSecretId)).toBe(
      "ciphertext-bob"
    );
    await secrets.deleteEncryptedSecret(alice, sharedSecretId);
    expect(
      await secrets.readEncryptedSecret(alice, sharedSecretId)
    ).toBeUndefined();
    expect(await secrets.readEncryptedSecret(bob, sharedSecretId)).toBe(
      "ciphertext-bob"
    );
    // PGlite migrations take several seconds alone and longer beside the
    // other database suites on a loaded runner.
  }, 30_000);
});

async function applyInitialMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0000_fluffy_the_spike.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applyBrowserImageMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0003_unusual_fabian_cortez.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applyBrowserTraceMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0004_kind_manta.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applyBrowserTraceEventMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0005_brave_kang.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applySchemaAdoptionMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0006_illegal_tattoo.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applyNativeTypesMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0008_black_sandman.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applySiteMigrations(database: PGlite) {
  /* oxlint-disable eslint/no-await-in-loop -- Migrations and their statements must execute in order. */
  for (const name of ["0016_fair_psylocke.sql", "0017_parallel_hulk.sql"]) {
    const migration = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8"
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applyChatChannelMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0011_faulty_unicorn.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}
