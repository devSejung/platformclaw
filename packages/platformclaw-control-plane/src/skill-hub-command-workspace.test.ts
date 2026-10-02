import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { KnoxRoomAgentBinding } from "./contracts.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";
import {
  assertSkillHubWorkspace,
  resolveKnoxSkillHubWorkspace,
  type KnoxSkillHubCommandContext,
} from "./skill-hub-command-workspace.js";

const workspaceRoot = path.resolve("test-skillhub-workspaces");
const buildAgentMainSessionKey = ({ agentId }: { agentId: string }) => `agent:${agentId}:main`;

async function fixture() {
  const store = new InMemoryControlPlaneStore({ buildAgentMainSessionKey });
  const { user } = await store.upsertPrincipal(
    { provider: "ldap", subject: "person.one", accountId: "person.one", employeeId: "1001" },
    1,
  );
  const reservation = await store.reserveKnoxRoomAgent({
    accountId: "relay-one",
    roomId: "room-one",
    reservedAt: 2,
  });
  const roomBinding = (await store.transitionAgent({
    bindingId: reservation.binding.id,
    state: "active",
    changedAt: 3,
  })) as KnoxRoomAgentBinding;
  const context: KnoxSkillHubCommandContext = {
    accountId: roomBinding.accountId,
    conversationType: "room",
    conversationId: roomBinding.roomId,
    agentId: roomBinding.agentId,
    sessionKey: buildAgentMainSessionKey({ agentId: roomBinding.agentId }),
  };
  const resolve = (overrides: Partial<KnoxSkillHubCommandContext> = {}, sender = user.accountId) =>
    resolveKnoxSkillHubWorkspace({
      store,
      workspaceRoot,
      senderAccountId: sender,
      context: { ...context, ...overrides },
      buildAgentMainSessionKey,
    });
  return { store, user, roomBinding, context, resolve };
}

describe("Knox SkillHub command workspace", () => {
  it("uses the active room workspace for a linked sender without a personal Agent", async () => {
    const f = await fixture();
    const personalRoute = vi.spyOn(f.store, "resolveAuthenticatedKnoxDmRoute");

    await expect(f.resolve()).resolves.toEqual({
      user: f.user,
      agentId: f.roomBinding.agentId,
      workspaceDir: path.join(workspaceRoot, f.roomBinding.agentId),
      roomBinding: f.roomBinding,
    });
    expect(personalRoute).not.toHaveBeenCalled();
  });

  it.each([
    { accountId: "other-relay" },
    { conversationId: "other-room" },
    { agentId: "other-agent" },
    { sessionKey: "agent:other-agent:main" },
  ])("rejects mismatched room authority %j", async (overrides) => {
    const f = await fixture();
    await expect(f.resolve(overrides)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects unlinked room senders and inactive room bindings", async () => {
    const f = await fixture();
    await expect(f.resolve({}, "unlinked.person")).rejects.toMatchObject({ statusCode: 401 });
    await f.store.transitionAgent({ bindingId: f.roomBinding.id, state: "disabled", changedAt: 4 });
    await expect(f.resolve()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("keeps DMs pinned to the authenticated personal Agent and main session", async () => {
    const f = await fixture();
    const personal = await f.store.reservePersonalAgent(f.user.id, 4);
    await f.store.transitionAgent({
      bindingId: personal.binding.id,
      state: "active",
      changedAt: 5,
    });
    const dm = {
      conversationType: "dm" as const,
      agentId: personal.binding.agentId,
      sessionKey: buildAgentMainSessionKey({ agentId: personal.binding.agentId }),
    };
    await expect(f.resolve(dm)).resolves.toEqual({
      user: f.user,
      agentId: personal.binding.agentId,
      workspaceDir: path.join(workspaceRoot, personal.binding.agentId),
    });
    await expect(f.resolve({ ...dm, agentId: f.roomBinding.agentId })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(f.resolve({ ...dm, sessionKey: "agent:someone-else:main" })).rejects.toMatchObject(
      {
        statusCode: 409,
      },
    );
  });

  it.each(["../outside", ".", "nested/agent", "MixedCase", " padded "])(
    "rejects an invalid stored workspace agent %s",
    async (agentId) => {
      const f = await fixture();
      vi.spyOn(f.store, "listAgentBindingsByState").mockResolvedValue([
        { ...f.roomBinding, agentId },
      ]);
      await expect(
        f.resolve({ agentId, sessionKey: buildAgentMainSessionKey({ agentId }) }),
      ).rejects.toMatchObject({ statusCode: 500 });
    },
  );

  it("revalidates room binding identity before workspace operations", async () => {
    const f = await fixture();
    const actor = await f.resolve();
    await expect(assertSkillHubWorkspace(f.store, actor)).resolves.toBeUndefined();
    vi.spyOn(f.store, "listAgentBindingsByState").mockResolvedValue([
      { ...f.roomBinding, id: "replacement-binding" },
    ]);
    await expect(assertSkillHubWorkspace(f.store, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("rejects a sender disabled after room admission", async () => {
    const f = await fixture();
    const actor = await f.resolve();
    vi.spyOn(f.store, "getUserById").mockResolvedValue({ ...f.user, status: "disabled" });
    await expect(assertSkillHubWorkspace(f.store, actor)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
