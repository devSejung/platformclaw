import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_SESSION_POLICY,
  ControlPlaneStateError,
  type ControlPlaneIdFactory,
  type EnterprisePrincipal,
} from "./contracts.js";
import { deriveKnoxRoomAgentId } from "./ids.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";

function createIdFactory(): ControlPlaneIdFactory {
  let user = 0;
  let binding = 0;
  let session = 0;
  let scope = 0;
  let audit = 0;
  return {
    nextUserId: () => `user-${++user}`,
    nextBindingId: () => `binding-${++binding}`,
    nextSessionId: () => `session-${++session}`,
    nextManagedScopeId: () => `scope-${++scope}`,
    nextAuditEventId: () => `audit-${++audit}`,
  };
}

function createStore() {
  return new InMemoryControlPlaneStore({
    idFactory: createIdFactory(),
    initialAdminAccountIds: ["admin.user"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
}

async function disableUser(
  store: InMemoryControlPlaneStore,
  targetUserId: string,
  changedAt: number,
) {
  const admin = await store.upsertPrincipal(
    ldapPrincipal({ subject: "admin-subject", employeeId: "admin.user" }),
    changedAt - 1,
  );
  await store.setManagedUserStatus({
    actorUserId: admin.user.id,
    targetUserId,
    status: "disabled",
    changedAt,
  });
}

function ldapPrincipal(overrides: Partial<EnterprisePrincipal> = {}): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: "ldap-subject-1",
    employeeId: "employee-1",
    displayName: "First Name",
    email: "first@example.test",
    department: "Platform",
    groups: ["developers", "platform"],
    ...overrides,
  };
}

async function createActivePersonalAgent(store: InMemoryControlPlaneStore) {
  const principal = await store.upsertPrincipal(ldapPrincipal(), 1_000);
  const reservation = await store.reservePersonalAgent(principal.user.id, 2_000);
  const binding = await store.transitionAgent({
    bindingId: reservation.binding.id,
    state: "active",
    changedAt: 3_000,
  });
  if (binding.kind !== "personal") {
    throw new Error("expected personal binding");
  }
  return { user: principal.user, binding };
}

describe("personal agent id", () => {
  it("preserves the deployed account-id dot replacement", async () => {
    const store = createStore();
    const principal = await store.upsertPrincipal(
      ldapPrincipal({ accountId: "seungon.jung", employeeId: "employee-123" }),
      1_000,
    );
    const reservation = await store.reservePersonalAgent(principal.user.id, 2_000);

    expect(reservation.binding.agentId).toBe("seungon_jung");
    expect(principal.user).toMatchObject({
      accountId: "seungon.jung",
      employeeId: "employee-123",
    });
  });
});

describe("InMemoryControlPlaneStore enterprise identity", () => {
  it("preserves the canonical account when a linked provider omits accountId", async () => {
    const store = createStore();
    const ldap = await store.upsertPrincipal(
      ldapPrincipal({ accountId: "account.name", employeeId: "employee-123" }),
      1_000,
    );
    const saml = await store.upsertPrincipal(
      ldapPrincipal({
        provider: "saml",
        subject: "saml-subject-1",
        employeeId: "employee-123",
      }),
      2_000,
    );

    expect(saml.user).toMatchObject({ id: ldap.user.id, accountId: "account.name" });
  });

  it("keeps one user while mutable LDAP attributes change", async () => {
    const store = createStore();
    const first = await store.upsertPrincipal(ldapPrincipal(), 1_000);
    const second = await store.upsertPrincipal(
      ldapPrincipal({
        displayName: "Updated Name",
        department: "AI Platform",
        groups: ["platform", "admins", "platform"],
      }),
      2_000,
    );

    expect(first.createdUser).toBe(true);
    expect(second.createdUser).toBe(false);
    expect(second.createdIdentity).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user).toMatchObject({
      displayName: "Updated Name",
      department: "AI Platform",
      groups: ["admins", "platform"],
      updatedAt: 2_000,
    });
  });

  it("links a verified SAML identity to the existing employee user", async () => {
    const store = createStore();
    const ldap = await store.upsertPrincipal(ldapPrincipal(), 1_000);
    const saml = await store.upsertPrincipal(
      ldapPrincipal({
        provider: "saml",
        subject: "saml-subject-9",
        employeeId: "EMPLOYEE-1",
      }),
      2_000,
    );

    expect(saml.createdUser).toBe(false);
    expect(saml.createdIdentity).toBe(true);
    expect(saml.user.employeeId).toBe("employee-1");
    expect(saml.user.id).toBe(ldap.user.id);
    expect(saml.identity).toMatchObject({
      provider: "saml",
      subject: "saml-subject-9",
      userId: ldap.user.id,
    });
  });

  it("keeps the user and agent owner stable after an employee ID correction", async () => {
    const store = createStore();
    const first = await store.upsertPrincipal(ldapPrincipal(), 1_000);
    const agent = await store.reservePersonalAgent(first.user.id, 1_500);
    const corrected = await store.upsertPrincipal(
      ldapPrincipal({ employeeId: "employee-corrected" }),
      2_000,
    );

    expect(corrected.user.id).toBe(first.user.id);
    expect(await store.getUserByEmployeeId("employee-1")).toBeNull();
    expect(await store.getUserByEmployeeId("employee-corrected")).toMatchObject({
      id: first.user.id,
    });
    expect((await store.reservePersonalAgent(first.user.id, 2_500)).binding.id).toBe(
      agent.binding.id,
    );
  });

  it("fails closed when a linked provider still reports a stale employee ID", async () => {
    const store = createStore();
    await store.upsertPrincipal(ldapPrincipal(), 1_000);
    await store.upsertPrincipal(
      ldapPrincipal({ provider: "saml", subject: "saml-subject-9" }),
      1_100,
    );
    const corrected = await store.upsertPrincipal(
      ldapPrincipal({ employeeId: "employee-corrected" }),
      2_000,
    );

    await expect(
      store.upsertPrincipal(ldapPrincipal({ provider: "saml", subject: "saml-subject-9" }), 2_100),
    ).rejects.toMatchObject({ code: "employee_id_mismatch" });
    expect(await store.getUserByEmployeeId("employee-1")).toBeNull();
    expect(await store.getUserByEmployeeId("employee-corrected")).toMatchObject({
      id: corrected.user.id,
    });

    await expect(
      store.upsertPrincipal(
        ldapPrincipal({
          provider: "saml",
          subject: "saml-subject-9",
          employeeId: "employee-corrected",
        }),
        2_200,
      ),
    ).resolves.toMatchObject({
      user: { id: corrected.user.id },
      identity: { employeeId: "employee-corrected" },
    });
  });

  it("rejects out-of-order and equal-version employee ID changes", async () => {
    const store = createStore();
    await store.upsertPrincipal(ldapPrincipal(), 1_000);
    const corrected = await store.upsertPrincipal(
      ldapPrincipal({ employeeId: "employee-corrected" }),
      2_000,
    );

    await expect(store.upsertPrincipal(ldapPrincipal(), 1_500)).rejects.toMatchObject({
      code: "stale_authentication",
    });
    await expect(store.upsertPrincipal(ldapPrincipal(), 2_000)).rejects.toMatchObject({
      code: "stale_authentication",
    });
    await expect(
      store.upsertPrincipal(ldapPrincipal({ employeeId: "employee-corrected" }), 2_000),
    ).resolves.toMatchObject({ user: { id: corrected.user.id } });
    expect(await store.getUserByEmployeeId("employee-1")).toBeNull();
    expect(await store.getUserByEmployeeId("employee-corrected")).toMatchObject({
      id: corrected.user.id,
    });
  });

  it("rejects an employee ID correction that would merge two existing users", async () => {
    const store = createStore();
    await store.upsertPrincipal(ldapPrincipal(), 1_000);
    await store.upsertPrincipal(
      ldapPrincipal({ subject: "ldap-subject-2", employeeId: "employee-2" }),
      1_100,
    );

    await expect(
      store.upsertPrincipal(ldapPrincipal({ employeeId: "employee-2" }), 2_000),
    ).rejects.toMatchObject({
      code: "employee_id_conflict",
    });
  });
});

describe("InMemoryControlPlaneStore provisioning", () => {
  it("resolves the owned personal binding and records proxy audit events", async () => {
    const store = createStore();
    const { user, binding } = await createActivePersonalAgent(store);

    await expect(store.getPersonalAgentBinding(user.id)).resolves.toEqual(binding);
    await expect(
      store.recordAuditEvent({
        actorUserId: user.id,
        eventType: "browser.gateway.denied",
        targetType: "agent-binding",
        targetId: binding.id,
        details: { method: "config.get", reason: "method-not-allowed" },
        createdAt: 4_000,
      }),
    ).resolves.toMatchObject({
      actorUserId: user.id,
      eventType: "browser.gateway.denied",
      targetId: binding.id,
      details: { method: "config.get", reason: "method-not-allowed" },
    });
  });

  it("converges concurrent personal-agent reservations on one record", async () => {
    const store = createStore();
    const { user } = await store.upsertPrincipal(ldapPrincipal(), 1_000);

    const [first, second] = await Promise.all([
      store.reservePersonalAgent(user.id, 2_000),
      store.reservePersonalAgent(user.id, 2_000),
    ]);

    expect(first.binding).toEqual(second.binding);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.binding).toMatchObject({
      kind: "personal",
      userId: user.id,
      state: "provisioning",
    });
  });

  it("converges room reservations and fails closed on cross-account unsafe room IDs", async () => {
    const store = createStore();
    const params = { accountId: "knox-primary", roomId: "room/123", reservedAt: 1_000 };

    const [first, second] = await Promise.all([
      store.reserveKnoxRoomAgent(params),
      store.reserveKnoxRoomAgent(params),
    ]);
    expect(first.binding).toEqual(second.binding);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.binding.agentId).toBe(deriveKnoxRoomAgentId("room/123"));
    expect(first.binding.agentId).toMatch(/^group-[a-z0-9_-]+$/u);
    expect(first.binding.agentId.length).toBeLessThanOrEqual(64);
    await expect(
      store.reserveKnoxRoomAgent({ ...params, accountId: "knox-secondary" }),
    ).rejects.toMatchObject({ code: "agent_id_conflict" });
  });

  it("preserves the legacy group-chatroom ID shape when it is already safe", () => {
    expect(deriveKnoxRoomAgentId("room-123")).toBe("group-room-123");
  });

  it("fails closed when two Knox accounts claim the same legacy room agent ID", async () => {
    const store = createStore();
    await store.reserveKnoxRoomAgent({
      accountId: "knox-primary",
      roomId: "room-123",
      reservedAt: 1_000,
    });

    await expect(
      store.reserveKnoxRoomAgent({
        accountId: "knox-secondary",
        roomId: "room-123",
        reservedAt: 2_000,
      }),
    ).rejects.toMatchObject({ code: "agent_id_conflict" });
  });

  it("enforces provisioning state transitions", async () => {
    const store = createStore();
    const { binding } = await store.reserveKnoxRoomAgent({
      accountId: "knox-primary",
      roomId: "room-1",
      reservedAt: 1_000,
    });
    const active = await store.transitionAgent({
      bindingId: binding.id,
      state: "active",
      changedAt: 2_000,
    });

    expect(active.state).toBe("active");
    await expect(
      store.transitionAgent({
        bindingId: binding.id,
        state: "provisioning",
        changedAt: 3_000,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneStateError);
  });
});

describe("InMemoryControlPlaneStore browser sessions", () => {
  it("enforces the three-session limit without choosing an eviction policy", async () => {
    const store = createStore();
    const { user } = await store.upsertPrincipal(ldapPrincipal(), 1_000);
    for (let index = 1; index <= BROWSER_SESSION_POLICY.maxConcurrentSessions; index += 1) {
      await expect(
        store.createBrowserSession({
          userId: user.id,
          tokenHash: `hash-${index}`,
          createdAt: 2_000,
        }),
      ).resolves.toMatchObject({ status: "created" });
    }

    await expect(
      store.createBrowserSession({
        userId: user.id,
        tokenHash: "hash-4",
        createdAt: 2_000,
      }),
    ).resolves.toEqual({ status: "limit-reached", activeSessionCount: 3 });
  });

  it("distinguishes idle and absolute expiry and caps idle extension", async () => {
    const store = createStore();
    const { user } = await store.upsertPrincipal(ldapPrincipal(), 0);
    await store.createBrowserSession({ userId: user.id, tokenHash: "idle", createdAt: 0 });

    await expect(
      store.resolveBrowserSession({
        tokenHash: "idle",
        resolvedAt: BROWSER_SESSION_POLICY.idleTimeoutMs,
      }),
    ).resolves.toMatchObject({ status: "expired", reason: "idle" });

    const shortPolicyStore = new InMemoryControlPlaneStore({
      idFactory: createIdFactory(),
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      sessionPolicy: {
        idleTimeoutMs: 100,
        absoluteTimeoutMs: 250,
        maxConcurrentSessions: 3,
      },
    });
    const shortPolicyUser = await shortPolicyStore.upsertPrincipal(ldapPrincipal(), 0);
    await shortPolicyStore.createBrowserSession({
      userId: shortPolicyUser.user.id,
      tokenHash: "absolute",
      createdAt: 0,
    });
    await shortPolicyStore.resolveBrowserSession({ tokenHash: "absolute", resolvedAt: 99 });
    await shortPolicyStore.resolveBrowserSession({ tokenHash: "absolute", resolvedAt: 198 });
    const touched = await shortPolicyStore.resolveBrowserSession({
      tokenHash: "absolute",
      resolvedAt: 249,
    });
    expect(touched).toMatchObject({
      status: "active",
      session: { idleExpiresAt: 250 },
    });
    await expect(
      shortPolicyStore.resolveBrowserSession({
        tokenHash: "absolute",
        resolvedAt: 250,
      }),
    ).resolves.toMatchObject({ status: "expired", reason: "absolute" });
  });

  it("revokes all sessions when the user is disabled", async () => {
    const store = createStore();
    const { user } = await store.upsertPrincipal(ldapPrincipal(), 1_000);
    await store.createBrowserSession({ userId: user.id, tokenHash: "hash", createdAt: 2_000 });
    await disableUser(store, user.id, 3_000);

    await expect(
      store.resolveBrowserSession({ tokenHash: "hash", resolvedAt: 3_001 }),
    ).resolves.toMatchObject({ status: "revoked", session: { revokedAt: 3_000 } });
  });
});

describe("InMemoryControlPlaneStore authenticated Knox DM routing", () => {
  it("resolves only the active personal agent main session", async () => {
    const buildAgentMainSessionKey = vi.fn(
      ({ agentId }: { agentId: string }) => `canonical:${agentId}:main`,
    );
    const store = new InMemoryControlPlaneStore({
      idFactory: createIdFactory(),
      buildAgentMainSessionKey,
    });
    const { user, binding } = await createActivePersonalAgent(store);
    const sessionKey = `canonical:${binding.agentId}:main`;

    await expect(
      store.resolveAuthenticatedKnoxDmRoute({
        employeeId: user.employeeId,
        agentId: binding.agentId,
        sessionKey,
      }),
    ).resolves.toMatchObject({
      status: "resolved",
      user: { id: user.id },
      binding: { id: binding.id },
      sessionKey,
    });
    expect(buildAgentMainSessionKey).toHaveBeenCalledWith({ agentId: binding.agentId });
  });

  it("rejects Knox DM routing after the enterprise user is disabled", async () => {
    const store = createStore();
    const { user, binding } = await createActivePersonalAgent(store);
    await disableUser(store, user.id, 4_000);

    await expect(
      store.resolveAuthenticatedKnoxDmRoute({
        employeeId: user.employeeId,
        agentId: binding.agentId,
        sessionKey: `agent:${binding.agentId}:main`,
      }),
    ).resolves.toEqual({ status: "agent-unavailable" });
  });

  it("rejects a trusted-proxy route that does not match current ownership", async () => {
    const store = createStore();
    const { user, binding } = await createActivePersonalAgent(store);

    await expect(
      store.resolveAuthenticatedKnoxDmRoute({
        employeeId: user.employeeId,
        agentId: "another-agent",
        sessionKey: `agent:${binding.agentId}:main`,
      }),
    ).resolves.toEqual({ status: "route-mismatch" });
  });
});
