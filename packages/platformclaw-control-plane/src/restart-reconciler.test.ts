import { describe, expect, it, vi } from "vitest";
import { InMemoryControlPlaneStore } from "./memory-store.js";
import { AgentRestartReconciler } from "./restart-reconciler.js";

function createStore() {
  return new InMemoryControlPlaneStore({
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
}

async function reservePersonal(store: InMemoryControlPlaneStore, accountId = "person.one") {
  const { user } = await store.upsertPrincipal(
    {
      provider: "ldap",
      subject: accountId,
      accountId,
      employeeId: `employee-${accountId}`,
    },
    1_000,
  );
  return { user, ...(await store.reservePersonalAgent(user.id, 2_000)) };
}

describe("AgentRestartReconciler", () => {
  it("activates a fully owned personal agent", async () => {
    const store = createStore();
    const { binding } = await reservePersonal(store);
    const reconcileAfterRestart = vi.fn(async () => ({ status: "active" }) as const);
    const reconciler = new AgentRestartReconciler({
      store,
      personalAgentProbe: { reconcileAfterRestart },
      now: () => 3_000,
    });

    await expect(reconciler.reconcile()).resolves.toEqual({
      found: 1,
      activated: 1,
      failed: 0,
      disabled: 0,
    });
    await expect(store.getPersonalAgentBinding(binding.userId)).resolves.toMatchObject({
      state: "active",
    });
  });

  it("marks incomplete personal and room bindings for an explicit retry", async () => {
    const store = createStore();
    const { binding } = await reservePersonal(store);
    await store.reserveKnoxRoomAgent({
      accountId: "knox-main",
      roomId: "room-1",
      reservedAt: 2_100,
    });
    const reconciler = new AgentRestartReconciler({
      store,
      personalAgentProbe: {
        async reconcileAfterRestart() {
          return { status: "retry-required", reason: "profile-missing" };
        },
      },
      now: () => 3_000,
    });

    await expect(reconciler.reconcile()).resolves.toEqual({
      found: 2,
      activated: 0,
      failed: 2,
      disabled: 0,
    });
    await expect(store.getPersonalAgentBinding(binding.userId)).resolves.toMatchObject({
      state: "failed",
      failureCode: "restart_profile_missing",
    });
    await expect(store.listAgentBindingsByState("failed")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "knox-room", failureCode: "restart_room_runtime_pending" }),
      ]),
    );
  });

  it("leaves pending state untouched when the Gateway probe is unavailable", async () => {
    const store = createStore();
    const { binding } = await reservePersonal(store);
    const reconciler = new AgentRestartReconciler({
      store,
      personalAgentProbe: {
        async reconcileAfterRestart() {
          throw new Error("Gateway unavailable");
        },
      },
    });

    await expect(reconciler.reconcile()).rejects.toThrow("Gateway unavailable");
    await expect(store.getPersonalAgentBinding(binding.userId)).resolves.toMatchObject({
      state: "provisioning",
    });
  });

  it("records a profile ownership conflict without overwriting it", async () => {
    const store = createStore();
    const { binding } = await reservePersonal(store);
    const reconciler = new AgentRestartReconciler({
      store,
      personalAgentProbe: {
        async reconcileAfterRestart() {
          return { status: "conflict", reason: "profile-mismatch" };
        },
      },
      now: () => 3_000,
    });

    await expect(reconciler.reconcile()).resolves.toMatchObject({ failed: 1 });
    await expect(store.getPersonalAgentBinding(binding.userId)).resolves.toMatchObject({
      state: "failed",
      failureCode: "restart_profile_mismatch",
    });
  });
});
