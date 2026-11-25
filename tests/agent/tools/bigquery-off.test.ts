import type * as Eve from "eve";
import type { SessionAuthContext } from "eve/context";
import type * as EveInstructions from "eve/instructions";
import type * as EveTools from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import type * as Allowlist from "@db/services/auth/allowlist";
import { accessScopeForUser } from "@shared/identity/access-scope";

// The web member's user row, as the auth services read it.
const emailOfUser = vi.hoisted(() =>
  vi.fn<typeof Allowlist.emailOfUser>(async (userId) =>
    userId === "user-1" ? "member@example.test" : undefined
  )
);

vi.mock("@db/services/auth/allowlist", async (importOriginal) => ({
  ...(await importOriginal<typeof Allowlist>()),
  emailOfUser,
}));
vi.mock("eve", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof Eve>())
);
vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);
vi.mock("eve/instructions", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveInstructions>())
);

const member = accessScopeForUser("better-auth:user-1");
const web: SessionAuthContext = {
  attributes: { conversationChannel: "eve", workspaceId: member.workspaceId },
  authenticator: "authjs",
  principalId: member.userId,
  principalType: "user",
};
const whatsappFull: SessionAuthContext = {
  attributes: {
    conversationChannel: "whatsapp",
    email: "member@example.test",
    whatsappAccess: "full",
    whatsappNumber: "+15550000001",
    workspaceId: member.workspaceId,
  },
  authenticator: "assist-whatsapp",
  principalId: member.userId,
  principalType: "user",
};

// A made-up service account whose "key" is a marker, never a key. The PEM
// armour is assembled so no scanner reads it as one.
const serviceAccountKey = JSON.stringify({
  client_email: "reader@test-project.iam.gserviceaccount.com",
  private_key: [
    ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
    "TEST-ONLY-NOT-A-KEY",
    ["-----END", "PRIVATE", "KEY-----"].join(" "),
    "",
  ].join("\n"),
  type: "service_account",
});

const listed = "member@example.test";

// The tools and their instructions as a fresh process loads them, with
// ASSIST_BIGQUERY_KEY and ASSIST_BIGQUERY_EMAILS as given; the environment
// validates once on import. Each pair is the web chat's, then a full
// WhatsApp chat's.
async function loaded(key: string | undefined, emails: string | undefined) {
  vi.resetModules();
  vi.stubEnv("ASSIST_BIGQUERY_KEY", key);
  vi.stubEnv("ASSIST_BIGQUERY_EMAILS", emails);
  const [{ default: tools }, { default: instructions }] = await Promise.all([
    import("@agent/tools/bigquery"),
    import("@agent/instructions/26-bigquery"),
  ]);
  return Promise.all(
    [web, whatsappFull].flatMap((principal) => {
      const context = dynamicContextFor({
        auth: { current: principal, initiator: principal },
      });
      return [
        evaluateDynamic(tools, context),
        evaluateDynamic(instructions, context),
      ];
    })
  );
}

describe("BigQuery while it is off", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("offers no tool and no instruction anywhere while ASSIST_BIGQUERY_KEY is unset", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);

    expect(await loaded(undefined, listed)).toEqual([null, null, null, null]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["is not JSON", "-----not json {"],
    ["is not a service account", JSON.stringify({ type: "authorized_user" })],
    [
      "has no private key",
      JSON.stringify({
        client_email: "reader@test-project.iam.gserviceaccount.com",
        type: "service_account",
      }),
    ],
  ])(
    "turns BigQuery off when the key %s, and says so once without the value",
    async (_case, key) => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      expect(await loaded(key, listed)).toEqual([null, null, null, null]);

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "[bigquery] ASSIST_BIGQUERY_KEY is not a Google service account key; BigQuery is off."
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(key);
    }
  );
});

describe("BigQuery for the members on ASSIST_BIGQUERY_EMAILS", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    emailOfUser.mockClear();
  });

  it("offers the tools and their instructions to a listed member in the web chat and a full WhatsApp chat, whatever the list's case and spaces", async () => {
    const offered = await loaded(
      serviceAccountKey,
      " MEMBER@Example.test ,  other@example.test,"
    );

    expect(offered.map((value) => value !== null)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["only commas and spaces", " , "],
    ["listing someone else", "other@example.test"],
  ])(
    "offers nothing to anyone while ASSIST_BIGQUERY_EMAILS is %s, even with a key",
    async (_case, emails) => {
      expect(await loaded(serviceAccountKey, emails)).toEqual([
        null,
        null,
        null,
        null,
      ]);
    }
  );

  it("reads no user row while nobody is listed", async () => {
    await loaded(serviceAccountKey, undefined);

    expect(emailOfUser).not.toHaveBeenCalled();
  });
});
