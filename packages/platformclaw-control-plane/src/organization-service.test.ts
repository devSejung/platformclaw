import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlPlaneIdFactory, EnterprisePrincipal } from "./contracts.js";
import { ControlPlaneAuthorizationError, ControlPlaneConflictError } from "./contracts.js";
import { OrganizationService } from "./organization-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const directories: string[] = [];
let sequence = 0;

function ids(): ControlPlaneIdFactory {
  const next = (kind: string) => `${kind}-${++sequence}`;
  return {
    nextUserId: () => next("user"),
    nextBindingId: () => next("binding"),
    nextSessionId: () => next("session"),
    nextManagedScopeId: () => next("scope"),
    nextAuditEventId: () => next("audit"),
  };
}

function principal(accountId: string): EnterprisePrincipal {
  return { provider: "ldap", subject: accountId, accountId, employeeId: accountId };
}

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-organization-"));
  directories.push(directory);
  return new SqliteControlPlaneStore({
    databasePath: join(directory, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin"],
    idFactory: ids(),
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PlatformClaw organization services", () => {
  it("derives upward access and delegated management without descendants or siblings", async () => {
    const store = createStore();
    const admin = (await store.upsertPrincipal(principal("admin"), 1)).user;
    const groupLeader = (await store.upsertPrincipal(principal("leader"), 2)).user;
    const partMember = (await store.upsertPrincipal(principal("member"), 3)).user;
    const service = new OrganizationService(store, () => "join-1");
    const team = await service.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Engineering",
      createdAt: 10,
    });
    const group = await service.createScope({
      actorUserId: admin.id,
      kind: "group",
      name: "Platform",
      parentScopeId: team.id,
      createdAt: 11,
    });
    const part = await service.createScope({
      actorUserId: admin.id,
      kind: "part",
      name: "Runtime",
      parentScopeId: group.id,
      createdAt: 12,
    });
    const sibling = await service.createScope({
      actorUserId: admin.id,
      kind: "part",
      name: "Product",
      parentScopeId: group.id,
      createdAt: 13,
    });
    await service.assignMember({
      actorUserId: admin.id,
      scopeId: group.id,
      userId: groupLeader.id,
      role: "leader",
      reason: "appoint group leader",
      changedAt: 20,
    });
    await service.assignMember({
      actorUserId: admin.id,
      scopeId: part.id,
      userId: partMember.id,
      role: "member",
      reason: "assign runtime member",
      changedAt: 21,
    });

    await expect(
      service.authorization.authorizeManagedScope(partMember.id, team.id),
    ).resolves.toMatchObject({
      canRead: true,
      canManageMembers: false,
      facts: { source: "membership", scopeIds: [part.id] },
    });
    await expect(
      service.authorization.authorizeManagedScope(partMember.id, sibling.id),
    ).resolves.toMatchObject({
      canRead: false,
    });
    await expect(
      service.authorization.authorizeManagedScope(groupLeader.id, part.id),
    ).resolves.toMatchObject({
      canManageMembers: true,
      facts: { source: "leadership", scopeIds: [group.id] },
    });
    await expect(
      service.authorization.authorizeManagedScope(admin.id, sibling.id),
    ).resolves.toMatchObject({
      canRead: true,
      canManageLeaders: true,
      facts: { source: "administrator" },
    });
    await service.assignMember({
      actorUserId: admin.id,
      scopeId: sibling.id,
      userId: partMember.id,
      role: "member",
      reason: "second direct membership",
      changedAt: 29,
    });
    await service.removeMember({
      actorUserId: admin.id,
      scopeId: part.id,
      userId: partMember.id,
      reason: "move to sibling",
      changedAt: 30,
    });
    await expect(
      service.authorization.authorizeManagedScope(partMember.id, part.id),
    ).resolves.toMatchObject({ canRead: false });
    await expect(
      service.authorization.authorizeManagedScope(partMember.id, sibling.id),
    ).resolves.toMatchObject({ canRead: true });
    expect(
      (await service.authorization.listEffectiveAccess(partMember.id)).map(
        (entry) => entry.scope.id,
      ),
    ).toEqual(expect.arrayContaining([team.id, group.id, sibling.id]));
    await expect(
      service.assignMember({
        actorUserId: partMember.id,
        scopeId: sibling.id,
        userId: partMember.id,
        role: "member",
        reason: "unauthorized sibling assignment",
        changedAt: 31,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneAuthorizationError);
    const denial = (await store.listAuditEvents()).find(
      (event) => event.eventType === "scope.membership.set.denied",
    );
    expect(denial?.details).toMatchObject({
      outcome: "denied",
      authorization: { source: "membership", scopeIds: [sibling.id] },
    });
    await service.archiveScope({
      actorUserId: admin.id,
      scopeId: team.id,
      reason: "retire engineering tree",
      archivedAt: 32,
    });
    const archive = (await store.listAuditEvents()).find(
      (event) => event.eventType === "scope.archived",
    );
    expect(archive?.details).toMatchObject({
      outcome: "succeeded",
      reason: "retire engineering tree",
      authorization: { source: "administrator", scopeIds: [team.id] },
    });
    expect(archive?.details?.archivedScopeIds).toEqual(
      [team.id, group.id, part.id, sibling.id].toSorted(),
    );
    await expect(
      service.authorization.authorizeManagedScope(partMember.id, sibling.id),
    ).resolves.toMatchObject({ canRead: false });
    await expect(service.authorization.listEffectiveAccess(partMember.id)).resolves.toEqual([]);
    store.close();
  });

  it("owns join request IDs and commits approval, membership, primary cleanup, and audit", async () => {
    const store = createStore();
    const admin = (await store.upsertPrincipal(principal("admin"), 1)).user;
    const leader = (await store.upsertPrincipal(principal("leader"), 2)).user;
    const applicant = (await store.upsertPrincipal(principal("applicant"), 3)).user;
    const requestIds = ["join-1", "join-2"];
    const service = new OrganizationService(store, () => requestIds.shift() ?? "join-collision");
    const team = await service.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Engineering",
      createdAt: 10,
    });
    await service.assignMember({
      actorUserId: admin.id,
      scopeId: team.id,
      userId: leader.id,
      role: "leader",
      reason: "appoint team leader",
      changedAt: 11,
    });
    const request = await service.requestMembership({
      userId: applicant.id,
      scopeId: team.id,
      reason: "join engineering",
      submittedAt: 20,
    });
    expect(request.id).toBe("join-1");
    await expect(
      service.requestMembership({
        userId: applicant.id,
        scopeId: team.id,
        reason: "duplicate",
        submittedAt: 21,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneConflictError);
    await expect(
      service.decideMembershipRequest({
        actorUserId: applicant.id,
        requestId: request.id,
        decision: "approved",
        reason: "self",
        decidedAt: 22,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneAuthorizationError);
    await service.decideMembershipRequest({
      actorUserId: leader.id,
      requestId: request.id,
      decision: "approved",
      reason: "approved",
      decidedAt: 23,
    });
    expect(await store.listManagedScopeMemberships(team.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: applicant.id, role: "member" })]),
    );
    await store.setUserPrimaryScope({
      actorUserId: applicant.id,
      userId: applicant.id,
      scopeId: team.id,
      changedAt: 24,
    });
    await store.removeManagedScopeMembership({
      actorUserId: admin.id,
      scopeId: team.id,
      userId: applicant.id,
      reason: "remove applicant",
      changedAt: 25,
    });
    await expect(store.getUserPrimaryScope(applicant.id)).resolves.toBeNull();
    expect((await store.listAuditEvents()).map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["organization.join.requested", "organization.join.approved"]),
    );
    store.close();
  });

  it("resolves a matching pending request when a leader assigns membership directly", async () => {
    const store = createStore();
    const admin = (await store.upsertPrincipal(principal("admin"), 1)).user;
    const leader = (await store.upsertPrincipal(principal("leader"), 2)).user;
    const applicant = (await store.upsertPrincipal(principal("applicant"), 3)).user;
    const service = new OrganizationService(store, () => "join-direct");
    const team = await service.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Engineering",
      createdAt: 10,
    });
    await service.assignMember({
      actorUserId: admin.id,
      scopeId: team.id,
      userId: leader.id,
      role: "leader",
      reason: "appoint team leader",
      changedAt: 11,
    });
    await service.requestMembership({
      userId: applicant.id,
      scopeId: team.id,
      reason: "join engineering",
      submittedAt: 20,
    });

    await service.assignMember({
      actorUserId: leader.id,
      scopeId: team.id,
      userId: applicant.id,
      role: "member",
      reason: "approved by direct assignment",
      changedAt: 21,
    });

    await expect(service.listOwnRequests(applicant.id, 1)).resolves.toEqual([
      expect.objectContaining({ id: "join-direct", status: "approved", decidedAt: 21 }),
    ]);
    expect((await store.listAuditEvents()).map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["scope.membership.set", "organization.join.approved"]),
    );
    store.close();
  });

  it("lists only pending requests reviewable through the current active hierarchy", async () => {
    const store = createStore();
    const admin = (await store.upsertPrincipal(principal("admin"), 1)).user;
    const leader = (await store.upsertPrincipal(principal("leader"), 2)).user;
    const first = (await store.upsertPrincipal(principal("first"), 3)).user;
    const second = (await store.upsertPrincipal(principal("second"), 4)).user;
    const requestIds = ["join-part", "join-sibling"];
    const service = new OrganizationService(store, () => requestIds.shift()!);
    const team = await service.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Engineering",
      createdAt: 10,
    });
    const group = await service.createScope({
      actorUserId: admin.id,
      kind: "group",
      name: "Platform",
      parentScopeId: team.id,
      createdAt: 11,
    });
    const part = await service.createScope({
      actorUserId: admin.id,
      kind: "part",
      name: "Runtime",
      parentScopeId: group.id,
      createdAt: 12,
    });
    const siblingTeam = await service.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Sales",
      createdAt: 13,
    });
    await service.assignMember({
      actorUserId: admin.id,
      scopeId: group.id,
      userId: leader.id,
      role: "leader",
      reason: "appoint platform leader",
      changedAt: 14,
    });
    await service.requestMembership({
      userId: first.id,
      scopeId: part.id,
      reason: "join runtime",
      submittedAt: 20,
    });
    await service.requestMembership({
      userId: second.id,
      scopeId: siblingTeam.id,
      reason: "join sales",
      submittedAt: 21,
    });

    await expect(service.listReviewableRequests(leader.id, 1)).resolves.toEqual([
      expect.objectContaining({ id: "join-part" }),
    ]);
    await service.removeMember({
      actorUserId: admin.id,
      scopeId: group.id,
      userId: leader.id,
      reason: "remove reviewer",
      changedAt: 22,
    });
    await expect(service.listReviewableRequests(leader.id)).resolves.toEqual([]);
    await expect(service.listReviewableRequests(admin.id)).resolves.toEqual([
      expect.objectContaining({ id: "join-sibling" }),
      expect.objectContaining({ id: "join-part" }),
    ]);
    store.close();
  });
});
