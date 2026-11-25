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
import { accessScopeForUser } from "@shared/identity/access-scope";

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

// The tools and their instructions as a fresh process loads them, with
// ASSIST_BIGQUERY_KEY as given; the environment validates once on import.
async function loaded(key: string | undefined) {
  vi.resetModules();
  vi.stubEnv("ASSIST_BIGQUERY_KEY", key);
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

    expect(await loaded(undefined)).toEqual([null, null, null, null]);
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

      expect(await loaded(key)).toEqual([null, null, null, null]);

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "[bigquery] ASSIST_BIGQUERY_KEY is not a Google service account key; BigQuery is off."
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(key);
    }
  );
});
