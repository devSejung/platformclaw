import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlPlaneIdFactory, EnterprisePrincipal, PlatformUser } from "./contracts.js";
import { OrganizationService } from "./organization-service.js";
import { resolveSkillHubNamespaceCapabilities } from "./skill-hub-organization-policy.js";
import type { SkillHubNamespaceBinding } from "./skill-hub-state.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const directories: string[] = [];

function principal(accountId: string): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: `subject:${accountId}`,
    accountId,
    employeeId: `employee:${accountId}`,
    groups: [],
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-skillhub-org-policy-"));
  directories.push(directory);
  let id = 0;
  const idFactory: ControlPlaneIdFactory = {
    nextUserId: () => `user-${++id}`,
    nextBindingId: () => `binding-${++id}`,
    nextSessionId: () => `session-${++id}`,
    nextManagedScopeId: () => `scope-${++id}`,
    nextAuditEventId: () => `audit-${++id}`,
  };
  const store = new SqliteControlPlaneStore({
    databasePath: join(directory, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
    idFactory,
  });
  return { store, organization: new OrganizationService(store) };
}

function binding(scopeKind: "team" | "group" | "part", scopeId: string): SkillHubNamespaceBinding {
  return {
    namespace: "engineering",
    scopeKind,
    scopeId,
    accessState: "active",
    visibilityCeiling: "NAMESPACE_ONLY",
    createdByUserId: "admin",
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Skill Hub organization policy", () => {
  it("derives read and publish from real hierarchy facts without directory groups", async () => {
    const { store, organization } = fixture();
    const admin = (await store.upsertPrincipal(principal("admin.user"), 1)).user;
    const lowerMember = (await store.upsertPrincipal(principal("lower.user"), 2)).user;
    const upperMember = (await store.upsertPrincipal(principal("upper.user"), 3)).user;
    const siblingMember = (await store.upsertPrincipal(principal("sibling.user"), 4)).user;
    const leader = (await store.upsertPrincipal(principal("leader.user"), 5)).user;
    const team = await organization.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Product",
      createdAt: 6,
    });
    const group = await organization.createScope({
      actorUserId: admin.id,
      kind: "group",
      name: "Engineering",
      parentScopeId: team.id,
      createdAt: 7,
    });
    const part = await organization.createScope({
      actorUserId: admin.id,
      kind: "part",
      name: "Runtime",
      parentScopeId: group.id,
      createdAt: 8,
    });
    const sibling = await organization.createScope({
      actorUserId: admin.id,
      kind: "part",
      name: "Web",
      parentScopeId: group.id,
      createdAt: 9,
    });
    for (const [user, scopeId, role] of [
      [lowerMember, part.id, "member"],
      [upperMember, group.id, "member"],
      [siblingMember, sibling.id, "member"],
      [leader, team.id, "leader"],
    ] as const) {
      await organization.assignMember({
        actorUserId: admin.id,
        scopeId,
        userId: user.id,
        role,
        reason: "policy fixture",
        changedAt: 10,
      });
    }

    const resolve = async (user: PlatformUser, target: SkillHubNamespaceBinding) =>
      resolveSkillHubNamespaceCapabilities({
        user,
        binding: target,
        organizationAuthorization: await organization.authorization.authorizeManagedScope(
          user.id,
          target.scopeId!,
        ),
      });

    await expect(resolve(lowerMember, binding("group", group.id))).resolves.toMatchObject({
      canReadInstall: true,
      canPublish: false,
    });
    await expect(resolve(upperMember, binding("part", part.id))).resolves.toMatchObject({
      canReadInstall: false,
      canPublish: false,
    });
    await expect(resolve(siblingMember, binding("part", part.id))).resolves.toMatchObject({
      canReadInstall: false,
      canPublish: false,
    });
    await expect(resolve(leader, binding("part", part.id))).resolves.toMatchObject({
      canReadInstall: false,
      canPublish: true,
      canCurate: true,
    });
    await expect(resolve(admin, binding("part", part.id))).resolves.toMatchObject({
      canReadInstall: true,
      canPublish: true,
    });

    await organization.assignMember({
      actorUserId: admin.id,
      scopeId: sibling.id,
      userId: upperMember.id,
      role: "member",
      reason: "multiple membership",
      changedAt: 11,
    });
    await expect(resolve(upperMember, binding("group", group.id))).resolves.toMatchObject({
      canReadInstall: true,
      canPublish: true,
    });

    await store.setManagedUserStatus({
      actorUserId: admin.id,
      targetUserId: upperMember.id,
      status: "disabled",
      changedAt: 12,
    });
    await expect(
      resolve({ ...upperMember, status: "disabled" }, binding("group", group.id)),
    ).resolves.toMatchObject({
      canReadInstall: false,
      canPublish: false,
    });
    store.close();
  });

  it("fails closed when an owning scope lineage is archived", async () => {
    const { store, organization } = fixture();
    const admin = (await store.upsertPrincipal(principal("admin.user"), 1)).user;
    const member = (await store.upsertPrincipal(principal("member.user"), 2)).user;
    const team = await organization.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Archived Team",
      createdAt: 3,
    });
    await organization.assignMember({
      actorUserId: admin.id,
      scopeId: team.id,
      userId: member.id,
      role: "member",
      reason: "policy fixture",
      changedAt: 4,
    });
    await organization.archiveScope({
      actorUserId: admin.id,
      scopeId: team.id,
      reason: "archive test",
      archivedAt: 5,
    });
    const authorization = await organization.authorization.authorizeManagedScope(
      member.id,
      team.id,
    );
    expect(
      resolveSkillHubNamespaceCapabilities({
        user: member,
        binding: binding("team", team.id),
        organizationAuthorization: authorization,
      }),
    ).toMatchObject({ canReadInstall: false, canPublish: false });
    store.close();
  });
});
