import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneIdFactory, EnterprisePrincipal } from "./contracts.js";
import { KnoxRoutingService } from "./knox-routing-service.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";

function createStore() {
  let id = 0;
  const next = (prefix: string) => `${prefix}-${++id}`;
  const idFactory: ControlPlaneIdFactory = {
    nextUserId: () => next("user"),
    nextBindingId: () => next("binding"),
    nextSessionId: () => next("session"),
    nextManagedScopeId: () => next("scope"),
    nextAuditEventId: () => next("audit"),
  };
  return new InMemoryControlPlaneStore({
    idFactory,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
}

const principal: EnterprisePrincipal = {
  provider: "ldap",
  subject: "ldap:user.name",
  accountId: "user.name",
  employeeId: "login-name",
};

describe("KnoxRoutingService", () => {
  it("resolves DM from raw Knox user id to active personal main session", async () => {
    const store = createStore();
    const { user } = await store.upsertPrincipal(principal, 1_000);
    const reserved = await store.reservePersonalAgent(user.id, 2_000);
    await store.transitionAgent({
      bindingId: reserved.binding.id,
      state: "active",
      changedAt: 3_000,
    });
    const service = new KnoxRoutingService({
      store,
      roomProvisioner: { provision: vi.fn() },
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });

    await expect(
      service.resolve({
        accountId: "default",
        conversationType: "dm",
        conversationId: "42",
        knoxUserId: "USER.NAME",
      }),
    ).resolves.toEqual({
      status: "resolved",
      agentId: reserved.binding.agentId,
      sessionKey: `agent:${reserved.binding.agentId}:main`,
      senderLinked: true,
      executionTarget: "platform_server",
    });
  });

  it("single-flights room provisioning and permits an unlinked room sender", async () => {
    const store = createStore();
    const provision = vi.fn(async () => undefined);
    const service = new KnoxRoutingService({
      store,
      roomProvisioner: { provision },
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      now: () => 1_000,
    });
    const request = {
      accountId: "relay-a",
      conversationType: "room" as const,
      conversationId: "9988",
      knoxUserId: "unlinked.user",
    };

    const [first, second] = await Promise.all([service.resolve(request), service.resolve(request)]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "resolved",
      agentId: "group-9988",
      senderLinked: false,
      executionTarget: null,
    });
    expect(provision).toHaveBeenCalledOnce();
  });

  it("revalidates an active room agent before dispatch", async () => {
    const store = createStore();
    const provision = vi.fn(async () => undefined);
    const service = new KnoxRoutingService({
      store,
      roomProvisioner: { provision },
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      now: () => 1_000,
    });
    const request = {
      accountId: "relay-a",
      conversationType: "room" as const,
      conversationId: "9988",
      knoxUserId: "user.name",
    };

    await service.resolve(request);
    provision.mockClear();

    await expect(service.resolve(request)).resolves.toMatchObject({
      status: "resolved",
      agentId: "group-9988",
    });
    expect(provision).toHaveBeenCalledOnce();
  });

  it("requires prior Web login for DM", async () => {
    const service = new KnoxRoutingService({
      store: createStore(),
      roomProvisioner: { provision: vi.fn() },
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
    await expect(
      service.resolve({
        accountId: "default",
        conversationType: "dm",
        conversationId: "42",
        knoxUserId: "missing.user",
      }),
    ).resolves.toEqual({ status: "login-required" });
  });

  it("returns a permanent state for a disabled room binding", async () => {
    const store = createStore();
    const reservation = await store.reserveKnoxRoomAgent({
      accountId: "relay-a",
      roomId: "9988",
      reservedAt: 1_000,
    });
    await store.transitionAgent({
      bindingId: reservation.binding.id,
      state: "disabled",
      changedAt: 2_000,
    });
    const service = new KnoxRoutingService({
      store,
      roomProvisioner: { provision: vi.fn() },
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });

    await expect(
      service.resolve({
        accountId: "relay-a",
        conversationType: "room",
        conversationId: "9988",
        knoxUserId: "user.name",
      }),
    ).resolves.toEqual({ status: "room-disabled" });
  });
});
