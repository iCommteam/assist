import type {
  MemoryScopeContext,
  MemoryToolsContext,
  MemoryTurnStartedContext,
} from "eve/memory";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  patchUserProfile,
  readUserProfile,
} from "@db/services/user-profile";
import personalInfoMemory from "@agent/memory/personal_info";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { emptyUserProfile } from "@shared/user-profile/schema";

const services = vi.hoisted(() => ({
  patchUserProfile: vi.fn<typeof patchUserProfile>(),
  readUserProfile: vi.fn<typeof readUserProfile>(),
}));

vi.mock("@db/services/user-profile", () => services);

const owner = accessScopeForUser("better-auth:owner-1");
const profile = {
  ...emptyUserProfile,
  addressLine1: "1 Main Street",
  firstName: "Vadim",
};
const member = {
  attributes: { workspaceId: owner.workspaceId },
  authenticator: "authjs",
  principalId: owner.userId,
  principalType: "user",
};
const site = {
  attributes: { site: "teemiq", workspaceId: owner.workspaceId },
  authenticator: "assist-site",
  principalId: owner.userId,
  principalType: "user",
};

beforeEach(() => {
  vi.clearAllMocks();
  services.readUserProfile.mockResolvedValue(profile);
  services.patchUserProfile.mockResolvedValue(profile);
});

describe("Personal Info memory", () => {
  it("recalls and updates the member's Personal Info in an interactive chat", async () => {
    const chat = context({ current: member, initiator: member });

    expect(personalInfoMemory.scope(chat)).toBe(owner.workspaceId);
    const recalled =
      await personalInfoMemory.provider.recall["turn.started"](chat);
    expect(recalled?.messages[0]?.content).toContain("1 Main Street");
    expect(services.readUserProfile).toHaveBeenCalledExactlyOnceWith(owner);
    expect(
      Object.keys((await personalInfoMemory.provider.tools(chat)) ?? {})
    ).toEqual(["update"]);
  });

  it.each([
    ["the coordinator of a site task", { current: site, initiator: site }],
    ["the browser worker of a site task", { current: null, initiator: site }],
    [
      "the owner writing into a site task's chat",
      { current: member, initiator: site },
    ],
  ])(
    "is off for %s, so its pages never see or change the owner's details",
    async (_case, auth) => {
      const siteTask = context(auth);

      expect(personalInfoMemory.scope(siteTask)).toBeNull();
      expect(
        await personalInfoMemory.provider.recall["turn.started"](siteTask)
      ).toBeNull();
      expect(await personalInfoMemory.provider.tools(siteTask)).toBeNull();
      expect(services.readUserProfile).not.toHaveBeenCalled();
    }
  );
});

function context(auth: {
  current: typeof member | typeof site | null;
  initiator: typeof member | typeof site;
}) {
  return {
    abortSignal: new AbortController().signal,
    channel: { kind: "channel:eve", metadata: {} },
    async getSandbox() {
      throw new Error("Sandbox access is outside this test.");
    },
    memory: {
      scope: {
        key: "personal-info-key",
        namespace: "openinstinct-personal-info-v1",
        value: owner.workspaceId,
      },
      slot: "personal_info",
    },
    messages: [],
    operationId: "personal-info-recall",
    session: { auth, id: "session-1", turn: { id: "turn", sequence: 1 } },
    turn: { id: "turn", input: [], sequence: 1 },
  } satisfies MemoryTurnStartedContext &
    MemoryToolsContext &
    MemoryScopeContext;
}
