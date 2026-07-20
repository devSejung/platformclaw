import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  type ControlPlaneIdFactory,
  type EnterprisePrincipal,
} from "./contracts.js";
import { PLATFORMCLAW_CONTROL_SCHEMA_VERSION } from "./sqlite-schema.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const temporaryDirectories: string[] = [];

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

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-control-"));
  temporaryDirectories.push(directory);
  return join(directory, "state", "platformclaw-control.sqlite");
}

function createStore(databasePath = createDatabasePath()) {
  return new SqliteControlPlaneStore({
    databasePath,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
    idFactory: createIdFactory(),
  });
}

function principal(employeeId: string, overrides: Partial<EnterprisePrincipal> = {}) {
  return {
    provider: "ldap" as const,
    subject: `subject:${employeeId}`,
    employeeId,
    displayName: employeeId,
    department: "Platform",
    groups: ["developers", "platform", "developers"],
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteControlPlaneStore", () => {
  it("keeps account and employee IDs distinct when deriving a personal agent", async () => {
    const store = createStore();
    const created = await store.upsertPrincipal(
      principal("employee-123", { accountId: "seungon.jung" }),
      1_000,
    );
    const reservation = await store.reservePersonalAgent(created.user.id, 2_000);

    expect(created.user).toMatchObject({
      accountId: "seungon.jung",
      employeeId: "employee-123",
    });
    expect(reservation.binding.agentId).toBe("seungon_jung");
    store.close();
  });

  it("preserves the canonical account when a linked provider omits accountId", async () => {
    const store = createStore();
    const ldap = await store.upsertPrincipal(
      principal("employee-123", { accountId: "account.name" }),
      1_000,
    );
    const saml = await store.upsertPrincipal(
      principal("employee-123", { provider: "saml", subject: "saml-subject-1" }),
      2_000,
    );

    expect(saml.user).toMatchObject({ id: ldap.user.id, accountId: "account.name" });
    store.close();
  });

  it.skipIf(process.platform === "win32")(
    "secures the database directory and WAL files before storing control-plane data",
    () => {
      const databasePath = createDatabasePath();
      const store = createStore(databasePath);
      expect(statSync(dirname(databasePath)).mode & 0o777).toBe(0o700);
      for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        if (existsSync(path)) {
          expect(statSync(path).mode & 0o777).toBe(0o600);
        }
      }
      store.close();
    },
  );

  it("refuses to bootstrap a new database without an initial administrator", () => {
    const databasePath = createDatabasePath();
    expect(
      () =>
        new SqliteControlPlaneStore({
          databasePath,
          buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
        }),
    ).toThrow("requires an initial administrator");
  });

  it("requires bootstrap configuration until an active administrator exists", async () => {
    const databasePath = createDatabasePath();
    const first = new SqliteControlPlaneStore({
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["not-yet-present"],
      idFactory: createIdFactory(),
    });
    const member = await first.upsertPrincipal(principal("member.user"), 1_000);
    expect(member.user.globalRole).toBe("member");
    first.close();

    expect(
      () =>
        new SqliteControlPlaneStore({
          databasePath,
          buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
        }),
    ).toThrow("without an active administrator");

    const recovery = new SqliteControlPlaneStore({
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["member.user"],
      idFactory: createIdFactory(),
    });
    expect((await recovery.upsertPrincipal(principal("member.user"), 2_000)).user.globalRole).toBe(
      "admin",
    );
    recovery.close();
  });

  it("creates schema v1 and persists identity, role, and directory groups", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const first = await store.upsertPrincipal(principal("admin.user"), 1_000);
    expect(first.user).toMatchObject({
      accountId: "admin.user",
      employeeId: "admin.user",
      globalRole: "admin",
      groups: ["developers", "platform"],
      lastLoginAt: 1_000,
    });
    store.close();

    const reopened = createStore(databasePath);
    expect(await reopened.getUserByEmployeeId("admin.user")).toMatchObject({
      id: first.user.id,
      globalRole: "admin",
      groups: ["developers", "platform"],
    });
    reopened.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
    });
    database.close();
  });

  it("links LDAP and SAML identities when account casing differs", async () => {
    const store = createStore();
    const ldap = await store.upsertPrincipal(principal("Mixed.User"), 1_000);
    const saml = await store.upsertPrincipal(
      principal("mixed.user", { provider: "saml", subject: "saml:mixed.user" }),
      2_000,
    );

    expect(saml.user.id).toBe(ldap.user.id);
    expect(saml.user).toMatchObject({ accountId: "mixed.user", employeeId: "mixed.user" });
    expect(saml.createdUser).toBe(false);
    store.close();
  });

  it("uses account-id dot replacement and rejects an agent-id collision", async () => {
    const store = createStore();
    const dotted = await store.upsertPrincipal(principal("first.user"), 1_000);
    const underscored = await store.upsertPrincipal(principal("first_user"), 1_001);

    expect((await store.reservePersonalAgent(dotted.user.id, 2_000)).binding.agentId).toBe(
      "first_user",
    );
    await expect(store.reservePersonalAgent(underscored.user.id, 2_001)).rejects.toMatchObject({
      code: "agent_id_conflict",
    } satisfies Partial<ControlPlaneConflictError>);
    store.close();
  });

  it("resolves the owned personal binding and persists proxy audit events", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const { user } = await store.upsertPrincipal(principal("member.user"), 1_000);
    const reserved = await store.reservePersonalAgent(user.id, 2_000);
    const binding = await store.transitionAgent({
      bindingId: reserved.binding.id,
      state: "active",
      changedAt: 3_000,
    });

    await expect(store.getPersonalAgentBinding(user.id)).resolves.toEqual(binding);
    const audit = await store.recordAuditEvent({
      actorUserId: user.id,
      eventType: "browser.gateway.denied",
      targetType: "agent-binding",
      targetId: binding.id,
      details: { method: "config.get", reason: "method-not-allowed" },
      createdAt: 4_000,
    });
    store.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      database
        .prepare(
          "SELECT event_type, target_id, details_json FROM control_audit_events WHERE id = ?",
        )
        .get(audit.id),
    ).toEqual({
      event_type: "browser.gateway.denied",
      target_id: binding.id,
      details_json: JSON.stringify({ method: "config.get", reason: "method-not-allowed" }),
    });
    database.close();
  });

  it("persists server-side sessions and revokes them when a user is disabled", async () => {
    const store = createStore();
    const { user } = await store.upsertPrincipal(principal("member.user"), 1_000);
    const created = await store.createBrowserSession({
      userId: user.id,
      tokenHash: "sha256:test-session",
      createdAt: 2_000,
    });
    expect(created.status).toBe("created");
    const admin = await store.upsertPrincipal(principal("admin.user"), 2_001);
    await store.setManagedUserStatus({
      actorUserId: admin.user.id,
      targetUserId: user.id,
      status: "disabled",
      changedAt: 3_000,
    });
    expect(
      await store.resolveBrowserSession({ tokenHash: "sha256:test-session", resolvedAt: 3_001 }),
    ).toMatchObject({ status: "revoked" });
    store.close();
  });

  it("supports admin-created group/part hierarchy and inherited leader management", async () => {
    const store = createStore();
    const admin = await store.upsertPrincipal(principal("admin.user"), 1_000);
    const leader = await store.upsertPrincipal(principal("leader.user"), 1_001);
    const member = await store.upsertPrincipal(principal("member.user"), 1_002);
    const group = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "AI Platform",
      createdAt: 2_000,
    });
    const part = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      parentGroupId: group.id,
      name: "Agent Runtime",
      createdAt: 2_001,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: group.id,
      userId: leader.user.id,
      role: "leader",
      changedAt: 3_000,
    });
    await store.setManagedScopeMembership({
      actorUserId: leader.user.id,
      scopeId: part.id,
      userId: member.user.id,
      role: "member",
      changedAt: 3_001,
    });

    expect(await store.listManagedScopeMemberships(part.id)).toMatchObject([
      { userId: member.user.id, role: "member" },
    ]);
    await expect(
      store.setManagedScopeMembership({
        actorUserId: leader.user.id,
        scopeId: part.id,
        userId: member.user.id,
        role: "leader",
        changedAt: 3_002,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneAuthorizationError);
    expect((await store.listAuditEvents()).map((event) => event.eventType)).toEqual([
      "scope.membership.set",
      "scope.membership.set",
      "scope.created",
      "scope.created",
    ]);
    store.close();
  });

  it("does not let leaders change or remove leader assignments", async () => {
    const store = createStore();
    const admin = await store.upsertPrincipal(principal("admin.user"), 1_000);
    const firstLeader = await store.upsertPrincipal(principal("first.leader"), 1_001);
    const secondLeader = await store.upsertPrincipal(principal("second.leader"), 1_002);
    const group = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "Security",
      createdAt: 2_000,
    });
    for (const userId of [firstLeader.user.id, secondLeader.user.id]) {
      await store.setManagedScopeMembership({
        actorUserId: admin.user.id,
        scopeId: group.id,
        userId,
        role: "leader",
        changedAt: 3_000,
      });
    }

    await expect(
      store.setManagedScopeMembership({
        actorUserId: firstLeader.user.id,
        scopeId: group.id,
        userId: secondLeader.user.id,
        role: "member",
        changedAt: 4_000,
      }),
    ).rejects.toThrow("only administrators can change leader roles");
    await expect(
      store.removeManagedScopeMembership({
        actorUserId: firstLeader.user.id,
        scopeId: group.id,
        userId: secondLeader.user.id,
        changedAt: 4_001,
      }),
    ).rejects.toThrow("only administrators can remove leaders");
    store.close();
  });

  it("rejects membership removal after a scope is archived", async () => {
    const store = createStore();
    const admin = await store.upsertPrincipal(principal("admin.user"), 1_000);
    const member = await store.upsertPrincipal(principal("member.user"), 1_001);
    const group = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "Archived Group",
      createdAt: 2_000,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: group.id,
      userId: member.user.id,
      role: "member",
      changedAt: 3_000,
    });
    await store.archiveManagedScope({
      actorUserId: admin.user.id,
      scopeId: group.id,
      archivedAt: 4_000,
    });

    await expect(
      store.removeManagedScopeMembership({
        actorUserId: admin.user.id,
        scopeId: group.id,
        userId: member.user.id,
        changedAt: 5_000,
      }),
    ).rejects.toThrow("cannot change memberships for an archived scope");
    store.close();
  });

  it("prevents an administrator from disabling their own account", async () => {
    const store = createStore();
    const admin = await store.upsertPrincipal(principal("admin.user"), 1_000);
    await expect(
      store.setManagedUserStatus({
        actorUserId: admin.user.id,
        targetUserId: admin.user.id,
        status: "disabled",
        changedAt: 2_000,
      }),
    ).rejects.toThrow("cannot change their own status");
    store.close();
  });
});
