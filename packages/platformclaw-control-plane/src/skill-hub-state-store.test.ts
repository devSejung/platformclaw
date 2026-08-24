import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlPlaneIdFactory, EnterprisePrincipal } from "./contracts.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const directories: string[] = [];

function store() {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-skill-hub-state-"));
  directories.push(directory);
  let id = 0;
  const idFactory: ControlPlaneIdFactory = {
    nextUserId: () => `user-${++id}`,
    nextBindingId: () => `binding-${++id}`,
    nextSessionId: () => `session-${++id}`,
    nextManagedScopeId: () => `scope-${++id}`,
    nextAuditEventId: () => `audit-${++id}`,
  };
  return new SqliteControlPlaneStore({
    databasePath: join(directory, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
    idFactory,
  });
}

function principal(accountId: string): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: `subject:${accountId}`,
    accountId,
    employeeId: `employee:${accountId}`,
    groups: [],
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite Skill Hub state", () => {
  it("uses Global without a scope ID and requires IDs for managed scope bindings", async () => {
    const db = store();
    const admin = (await db.upsertPrincipal(principal("admin.user"), 1)).user;
    const globalBinding = await db.setSkillHubNamespaceBinding({
      namespace: "company",
      scopeKind: "global",
      accessState: "restricted",
      visibilityCeiling: "NAMESPACE_ONLY",
      expectedUpdatedAt: null,
      reason: "initial global binding",
      actorUserId: admin.id,
      changedAt: 2,
    });
    expect(globalBinding).toMatchObject({ scopeKind: "global", accessState: "restricted" });
    await expect(
      db.setSkillHubNamespaceAccessState({
        namespace: "company",
        accessState: "active",
        expectedUpdatedAt: globalBinding.updatedAt,
        reason: "approved organization-wide visibility",
        actorUserId: admin.id,
        changedAt: 3,
      }),
    ).resolves.toMatchObject({ accessState: "active" });
    await expect(
      db.setSkillHubNamespaceAccessState({
        namespace: "company",
        accessState: "restricted",
        expectedUpdatedAt: globalBinding.updatedAt,
        reason: "stale update",
        actorUserId: admin.id,
        changedAt: 4,
      }),
    ).rejects.toThrow("reload and retry");
    await expect(
      db.setSkillHubNamespaceBinding({
        namespace: "engineering",
        scopeKind: "team",
        accessState: "active",
        visibilityCeiling: "NAMESPACE_ONLY",
        expectedUpdatedAt: null,
        reason: "invalid missing scope",
        actorUserId: admin.id,
        changedAt: 3,
      }),
    ).rejects.toThrow("namespace scope binding is invalid");
    db.close();
  });

  it("binds Part namespaces with CAS and blocks archived owning scopes", async () => {
    const db = store();
    const admin = (await db.upsertPrincipal(principal("admin.user"), 1)).user;
    const member = (await db.upsertPrincipal(principal("member.user"), 2)).user;
    const leader = (await db.upsertPrincipal(principal("leader.user"), 3)).user;
    const team = await db.createManagedScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Company",
      createdAt: 4,
    });
    const group = await db.createManagedScope({
      actorUserId: admin.id,
      kind: "group",
      name: "Engineering",
      parentScopeId: team.id,
      createdAt: 5,
    });
    const part = await db.createManagedScope({
      actorUserId: admin.id,
      kind: "part",
      name: "Runtime",
      parentScopeId: group.id,
      createdAt: 6,
    });
    await db.setManagedScopeMembership({
      actorUserId: admin.id,
      scopeId: part.id,
      userId: member.id,
      role: "member",
      reason: "test assignment",
      changedAt: 6,
    });
    await db.setManagedScopeMembership({
      actorUserId: admin.id,
      scopeId: group.id,
      userId: leader.id,
      role: "leader",
      reason: "test assignment",
      changedAt: 7,
    });
    const binding = await db.setSkillHubNamespaceBinding({
      namespace: "engineering-runtime",
      scopeKind: "part",
      scopeId: part.id,
      accessState: "active",
      visibilityCeiling: "NAMESPACE_ONLY",
      expectedUpdatedAt: null,
      reason: "bind runtime catalog",
      actorUserId: admin.id,
      changedAt: 8,
    });

    expect(binding).toMatchObject({ scopeId: part.id, accessState: "active" });
    await expect(
      db.archiveManagedScope({
        actorUserId: admin.id,
        scopeId: group.id,
        reason: "retire platform group",
        archivedAt: 9,
      }),
    ).rejects.toThrow("must be transferred or retired");
    await db.removeSkillHubNamespaceBinding({
      namespace: binding.namespace,
      expectedUpdatedAt: binding.updatedAt,
      reason: "retire empty namespace",
      actorUserId: admin.id,
      changedAt: 10,
    });
    await db.archiveManagedScope({
      actorUserId: admin.id,
      scopeId: group.id,
      reason: "binding retired",
      archivedAt: 11,
    });
    db.close();
  });

  it("persists expiring non-reshare ACLs and explicitly reassigns inactive owners", async () => {
    const db = store();
    const admin = (await db.upsertPrincipal(principal("admin.user"), 1)).user;
    const owner = (await db.upsertPrincipal(principal("owner.user"), 2)).user;
    const recipient = (await db.upsertPrincipal(principal("recipient.user"), 3)).user;
    const team = await db.createManagedScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Engineering",
      createdAt: 4,
    });
    await db.setManagedScopeMembership({
      actorUserId: admin.id,
      scopeId: team.id,
      userId: owner.id,
      role: "member",
      reason: "publication owner",
      changedAt: 4,
    });
    await db.setSkillHubNamespaceBinding({
      namespace: "engineering",
      scopeKind: "team",
      scopeId: team.id,
      accessState: "active",
      visibilityCeiling: "PUBLIC",
      expectedUpdatedAt: null,
      reason: "bind engineering catalog",
      actorUserId: admin.id,
      changedAt: 4,
    });
    await db.recordSkillHubPublication({
      namespace: "engineering",
      slug: "demo-skill",
      ownerUserId: owner.id,
      expectedOwnerUserId: null,
      expectedOwnerUpdatedAt: null,
      expectedBindingUpdatedAt: 4,
      visibility: "PRIVATE",
      version: "1.0.0",
      changedAt: 4,
    });
    const grant = await db.setSkillHubAccess({
      namespace: "engineering",
      slug: "demo-skill",
      userId: recipient.id,
      grantedByUserId: owner.id,
      expiresAt: 100,
      inheritVersions: false,
      grantedVersion: "1.0.0",
      changedAt: 5,
    });
    expect(grant).toMatchObject({ canReshare: false, inheritVersions: false });
    await expect(
      db.hasSkillHubAccess({
        namespace: "engineering",
        slug: "demo-skill",
        userId: recipient.id,
        version: "1.0.0",
        now: 99,
      }),
    ).resolves.toBe(true);
    await expect(
      db.hasSkillHubAccess({
        namespace: "engineering",
        slug: "demo-skill",
        userId: recipient.id,
        version: "1.0.0",
        now: 100,
      }),
    ).resolves.toBe(false);

    await db.setManagedUserStatus({
      actorUserId: admin.id,
      targetUserId: owner.id,
      status: "disabled",
      changedAt: 101,
    });
    await expect(db.reconcileInactiveSkillHubOwners(102)).resolves.toEqual({
      reassigned: 0,
      unassigned: 1,
    });
    await expect(db.getSkillHubOwnership("engineering", "demo-skill")).resolves.toMatchObject({
      ownerUserId: null,
      previousOwnerUserId: owner.id,
    });
    await expect(db.countUnreadSkillHubNotifications(admin.id)).resolves.toBe(1);
    db.close();
  });

  it("searches safe management candidates through current organization eligibility", async () => {
    const db = store();
    const admin = (await db.upsertPrincipal(principal("admin.user"), 1)).user;
    const owner = (await db.upsertPrincipal(principal("owner.user"), 2)).user;
    const eligible = (await db.upsertPrincipal(principal("eligible.user"), 3)).user;
    const outsider = (await db.upsertPrincipal(principal("outsider.user"), 4)).user;
    const team = await db.createManagedScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Engineering",
      createdAt: 5,
    });
    for (const user of [owner, eligible]) {
      await db.setManagedScopeMembership({
        actorUserId: admin.id,
        scopeId: team.id,
        userId: user.id,
        role: "member",
        reason: "search fixture",
        changedAt: 6,
      });
    }
    const binding = await db.setSkillHubNamespaceBinding({
      namespace: "engineering",
      scopeKind: "team",
      scopeId: team.id,
      accessState: "active",
      visibilityCeiling: "NAMESPACE_ONLY",
      expectedUpdatedAt: null,
      reason: "search fixture",
      actorUserId: admin.id,
      changedAt: 7,
    });
    const ownership = await db.recordSkillHubPublication({
      namespace: "engineering",
      slug: "demo",
      ownerUserId: owner.id,
      expectedOwnerUserId: null,
      expectedOwnerUpdatedAt: null,
      expectedBindingUpdatedAt: binding.updatedAt,
      visibility: "NAMESPACE_ONLY",
      version: "1.0.0",
      changedAt: 8,
    });
    const ownerCandidates = await db.searchSkillHubManagementUsers({
      namespace: "engineering",
      slug: "demo",
      actorUserId: owner.id,
      query: "user",
      purpose: "owner",
      limit: 20,
    });
    expect(ownerCandidates).toContainEqual(
      expect.objectContaining({ id: eligible.id, accountId: "eligible.user" }),
    );
    expect(ownerCandidates).not.toContainEqual(expect.objectContaining({ id: outsider.id }));
    const accessCandidates = await db.searchSkillHubManagementUsers({
      namespace: "engineering",
      slug: "demo",
      actorUserId: owner.id,
      query: "outsider",
      purpose: "access",
      limit: 20,
    });
    expect(accessCandidates).toEqual([{ id: outsider.id, accountId: "outsider.user" }]);
    expect(JSON.stringify(accessCandidates)).not.toMatch(/employeeId|email|groups|globalRole/iu);
    await expect(
      db.searchSkillHubManagementUsers({
        namespace: "engineering",
        slug: "demo",
        actorUserId: outsider.id,
        query: "user",
        purpose: "access",
        limit: 20,
      }),
    ).rejects.toThrow("owner or administrator required");
    await expect(
      db.searchSkillHubManagementUsers({
        namespace: "engineering",
        slug: "demo",
        actorUserId: owner.id,
        query: "%_",
        purpose: "access",
        limit: 20,
      }),
    ).resolves.toEqual([]);
    const sameMillisecond = await db.recordSkillHubPublication({
      namespace: "engineering",
      slug: "demo",
      ownerUserId: owner.id,
      expectedOwnerUserId: ownership.ownerUserId,
      expectedOwnerUpdatedAt: ownership.updatedAt,
      expectedBindingUpdatedAt: binding.updatedAt,
      visibility: "NAMESPACE_ONLY",
      version: "1.1.0",
      changedAt: ownership.updatedAt,
    });
    expect(sameMillisecond.updatedAt).toBe(ownership.updatedAt + 1);
    const staleSameMillisecond = await db.recordSkillHubPublication({
      namespace: "engineering",
      slug: "demo",
      ownerUserId: owner.id,
      expectedOwnerUserId: ownership.ownerUserId,
      expectedOwnerUpdatedAt: ownership.updatedAt,
      expectedBindingUpdatedAt: binding.updatedAt,
      visibility: "PUBLIC",
      version: "1.2.0",
      changedAt: ownership.updatedAt,
    });
    expect(staleSameMillisecond).toMatchObject({
      ownerUserId: null,
      visibility: "PRIVATE",
      reconciliationRequired: true,
    });
    const restored = await db.transferSkillHubOwner({
      namespace: "engineering",
      slug: "demo",
      expectedOwnerUserId: null,
      expectedOwnerUpdatedAt: staleSameMillisecond.updatedAt,
      ownerUserId: owner.id,
      registryVisibility: "NAMESPACE_ONLY",
      actorUserId: admin.id,
      changedAt: 9,
    });
    await db.removeManagedScopeMembership({
      actorUserId: admin.id,
      scopeId: team.id,
      userId: owner.id,
      reason: "membership revoked during publish",
      changedAt: 10,
    });
    const racedPublication = await db.recordSkillHubPublication({
      namespace: "engineering",
      slug: "demo",
      ownerUserId: owner.id,
      expectedOwnerUserId: restored.ownerUserId,
      expectedOwnerUpdatedAt: restored.updatedAt,
      expectedBindingUpdatedAt: binding.updatedAt,
      visibility: "PUBLIC",
      version: "2.0.0",
      changedAt: 11,
    });
    expect(racedPublication).toMatchObject({
      ownerUserId: null,
      visibility: "PRIVATE",
      currentVersion: "2.0.0",
      reconciliationRequired: true,
    });
    await expect(db.countUnreadSkillHubNotifications(admin.id)).resolves.toBe(2);
    await expect(
      db.transferSkillHubOwner({
        namespace: "engineering",
        slug: "demo",
        expectedOwnerUserId: null,
        expectedOwnerUpdatedAt: racedPublication.updatedAt,
        ownerUserId: eligible.id,
        registryVisibility: "PUBLIC",
        actorUserId: admin.id,
        changedAt: 12,
      }),
    ).resolves.toMatchObject({
      ownerUserId: eligible.id,
      visibility: "NAMESPACE_ONLY",
    });
    db.close();
  });
});
