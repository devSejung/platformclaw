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
    await expect(
      db.setSkillHubNamespaceBinding({
        namespace: "company",
        scopeKind: "global",
        visibilityCeiling: "NAMESPACE_ONLY",
        actorUserId: admin.id,
        changedAt: 2,
      }),
    ).resolves.toMatchObject({ scopeKind: "global", accessState: "restricted" });
    await expect(
      db.setSkillHubNamespaceBinding({
        namespace: "engineering",
        scopeKind: "team",
        visibilityCeiling: "NAMESPACE_ONLY",
        actorUserId: admin.id,
        changedAt: 3,
      }),
    ).rejects.toThrow("namespace scope binding is invalid");
    db.close();
  });

  it("binds Part access to direct members and parent Group leaders", async () => {
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
      visibilityCeiling: "NAMESPACE_ONLY",
      actorUserId: admin.id,
      changedAt: 8,
    });

    await expect(db.hasSkillHubNamespaceAccess(member.id, binding)).resolves.toBe(true);
    await expect(db.hasSkillHubNamespaceAccess(leader.id, binding)).resolves.toBe(true);
    await expect(db.hasSkillHubNamespaceAccess(admin.id, binding)).resolves.toBe(false);
    await expect(
      db.archiveManagedScope({
        actorUserId: admin.id,
        scopeId: group.id,
        reason: "retire platform group",
        archivedAt: 9,
      }),
    ).rejects.toThrow("must be transferred or retired");
    await expect(db.hasSkillHubNamespaceAccess(member.id, binding)).resolves.toBe(true);
    await db.removeSkillHubNamespaceBinding(binding.namespace);
    await db.archiveManagedScope({
      actorUserId: admin.id,
      scopeId: group.id,
      reason: "binding retired",
      archivedAt: 10,
    });
    await expect(db.hasSkillHubNamespaceAccess(member.id, binding)).resolves.toBe(false);
    await expect(db.hasSkillHubNamespaceAccess(leader.id, binding)).resolves.toBe(false);
    db.close();
  });

  it("persists expiring non-reshare ACLs and explicitly reassigns inactive owners", async () => {
    const db = store();
    const admin = (await db.upsertPrincipal(principal("admin.user"), 1)).user;
    const owner = (await db.upsertPrincipal(principal("owner.user"), 2)).user;
    const recipient = (await db.upsertPrincipal(principal("recipient.user"), 3)).user;
    await db.recordSkillHubPublication({
      namespace: "engineering",
      slug: "demo-skill",
      ownerUserId: owner.id,
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
    await expect(db.reconcileInactiveSkillHubOwners(102, admin.accountId)).resolves.toEqual({
      reassigned: 1,
      unassigned: 0,
    });
    await expect(db.getSkillHubOwnership("engineering", "demo-skill")).resolves.toMatchObject({
      ownerUserId: admin.id,
      previousOwnerUserId: owner.id,
    });
    await expect(db.countUnreadSkillHubNotifications(admin.id)).resolves.toBe(1);
    db.close();
  });
});
