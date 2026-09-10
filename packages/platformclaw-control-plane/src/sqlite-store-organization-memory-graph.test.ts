import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlPlaneIdFactory } from "./contracts.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const directories: string[] = [];

function ids(): ControlPlaneIdFactory {
  let value = 0;
  return {
    nextUserId: () => `user-${++value}`,
    nextBindingId: () => `binding-${++value}`,
    nextSessionId: () => `session-${++value}`,
    nextManagedScopeId: () => `scope-${++value}`,
    nextAuditEventId: () => `audit-${++value}`,
  };
}

async function activeUser(store: SqliteControlPlaneStore, accountId: string, at: number) {
  const { user } = await store.upsertPrincipal(
    { provider: "ldap", subject: accountId, accountId, employeeId: accountId },
    at,
  );
  const reserved = await store.reservePersonalAgent(user.id, at + 1);
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: at + 2,
  });
  return { user, binding };
}

function insertPage(
  db: DatabaseSync,
  params: {
    id: string;
    scopeKind: "part" | "group";
    scopeId: string;
    title?: string;
    provenance?: unknown;
  },
) {
  db.prepare(
    `INSERT INTO organization_memory_pages
      (id, scope_kind, scope_id, title, content, provenance_json, revision, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'active', 1, 1)`,
  ).run(
    params.id,
    params.scopeKind,
    params.scopeId,
    params.title ?? params.id,
    `${params.title ?? params.id} body`,
    JSON.stringify(params.provenance ?? {}),
  );
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("organization memory graphs", () => {
  it("separates authorized Part and Group pages and reflects membership revocation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-org-graph-"));
    directories.push(directory);
    const databasePath = join(directory, "control.sqlite");
    const store = new SqliteControlPlaneStore({
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["admin"],
      idFactory: ids(),
      resolvePersonalOrganizationMemorySource: async ({ lookup }) => ({
        claimId: lookup,
        revision: 1,
      }),
    });
    const admin = await activeUser(store, "admin", 10);
    const member = await activeUser(store, "member", 20);
    const team = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "team",
      name: "Company",
      createdAt: 30,
    });
    const groupA = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "Platform",
      parentScopeId: team.id,
      createdAt: 31,
    });
    const groupB = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "Product",
      parentScopeId: team.id,
      createdAt: 32,
    });
    const partA = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Runtime",
      parentScopeId: groupA.id,
      createdAt: 33,
    });
    const partB = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Design",
      parentScopeId: groupB.id,
      createdAt: 34,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: partA.id,
      userId: member.user.id,
      role: "member",
      reason: "test graph access",
      changedAt: 40,
    });
    await store.searchOrganizationMemory({ agentId: member.binding.agentId, query: "seed" });
    const db = new DatabaseSync(databasePath);
    insertPage(db, {
      id: "a-source",
      scopeKind: "part",
      scopeId: partA.id,
      title: "A source",
      provenance: { backlinks: ["b-target", "b-target"] },
    });
    insertPage(db, {
      id: "b-target",
      scopeKind: "part",
      scopeId: partA.id,
      title: "B target",
      provenance: { source: { kind: "part", claimId: "a-source" } },
    });
    insertPage(db, {
      id: "sibling",
      scopeKind: "part",
      scopeId: partB.id,
      title: "Sibling private",
      provenance: { source: { kind: "personal", claimId: "private/wiki.md" } },
    });
    insertPage(db, {
      id: "group-visible",
      scopeKind: "group",
      scopeId: groupA.id,
      title: "Group visible",
    });
    insertPage(db, {
      id: "group-private",
      scopeKind: "group",
      scopeId: groupB.id,
      title: "Group private",
    });
    db.close();

    const partGraph = await store.getOrganizationMemoryGraph({
      agentId: member.binding.agentId,
      kind: "part",
    });
    expect(partGraph.nodes.map((node) => node.path)).toEqual([
      "organization/part/a-source",
      "organization/part/b-target",
    ]);
    expect(partGraph.edges).toEqual([
      {
        source: "organization:part:a-source",
        target: "organization:part:b-target",
        type: "promotion",
      },
    ]);
    expect(JSON.stringify(partGraph)).not.toContain("private/wiki.md");
    expect(JSON.stringify(partGraph)).not.toContain("Sibling private");
    expect(
      (
        await store.getOrganizationMemoryGraph({
          agentId: member.binding.agentId,
          kind: "group",
        })
      ).nodes.map((node) => node.path),
    ).toEqual(["organization/group/group-visible"]);
    expect(
      (
        await store.getOrganizationMemoryGraph({
          agentId: admin.binding.agentId,
          kind: "part",
        })
      ).nodes.map((node) => node.path),
    ).toContain("organization/part/sibling");

    const personalRequest = await store.submitOrganizationMemoryPromotion({
      agentId: member.binding.agentId,
      sourceKind: "personal",
      sourceClaimId: "private/wiki.md",
      expectedSourceRevision: 1,
      targetKind: "part",
      targetScopeId: partA.id,
      proposedText: "Verified runbook",
      evidence: [],
      reason: "Reusable procedure",
      submittedAt: 42,
    });
    const approvedPart = await store.decideOrganizationMemoryPromotion({
      agentId: admin.binding.agentId,
      requestId: personalRequest.id,
      decision: "approve",
      reason: "Reviewed source",
      decidedAt: 43,
    });
    const groupRequest = await store.submitOrganizationMemoryPromotion({
      agentId: member.binding.agentId,
      sourceKind: "part",
      sourceClaimId: approvedPart.targetClaimId!,
      expectedSourceRevision: 1,
      targetKind: "group",
      targetScopeId: groupA.id,
      proposedText: "Shared runbook",
      evidence: [],
      reason: "Group procedure",
      submittedAt: 44,
    });
    const approvedGroup = await store.decideOrganizationMemoryPromotion({
      agentId: admin.binding.agentId,
      requestId: groupRequest.id,
      decision: "approve",
      reason: "Reviewed procedure",
      decidedAt: 45,
    });
    const verified = await store.getOrganizationMemoryGraph({
      agentId: member.binding.agentId,
      kind: "group",
    });
    expect(
      verified.nodes.find((node) => node.path.endsWith(approvedGroup.targetClaimId!))?.verification,
    ).toEqual({
      approvalStatus: "approved",
      revision: 1,
      sourceRevision: 1,
      sourceStatus: "current",
    });
    expect(
      verified.nodes.find((node) => node.path.endsWith("group-visible"))?.verification,
    ).toBeUndefined();
    await store.removeManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: partA.id,
      userId: member.user.id,
      reason: "revoke graph access",
      changedAt: 50,
    });
    await expect(
      store.getOrganizationMemoryGraph({ agentId: member.binding.agentId, kind: "part" }),
    ).resolves.toMatchObject({ nodes: [], edges: [], stats: { totalPages: 0 } });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: groupA.id,
      userId: member.user.id,
      role: "member",
      reason: "Group access only",
      changedAt: 51,
    });
    const groupOnly = await store.getOrganizationMemoryGraph({
      agentId: member.binding.agentId,
      kind: "group",
    });
    expect(
      groupOnly.nodes.find((node) => node.path.endsWith(approvedGroup.targetClaimId!))?.verification
        ?.sourceStatus,
    ).toBe("unavailable");
    expect(JSON.stringify(groupOnly)).not.toContain(approvedPart.targetClaimId!);
    expect(JSON.stringify(groupOnly)).not.toContain("private/wiki.md");
    await store.retireOrganizationMemoryClaim({
      agentId: admin.binding.agentId,
      claimId: approvedGroup.targetClaimId!,
      reason: "Superseded",
      retiredAt: 52,
    });
    const retired = await store.getOrganizationMemoryGraph({
      agentId: member.binding.agentId,
      kind: "group",
    });
    expect(retired.nodes.some((node) => node.path.endsWith(approvedGroup.targetClaimId!))).toBe(
      false,
    );
    await store.archiveManagedScope({
      actorUserId: admin.user.id,
      scopeId: groupA.id,
      reason: "Archived group",
      archivedAt: 53,
    });
    await expect(
      store.getOrganizationMemoryGraph({ agentId: member.binding.agentId, kind: "group" }),
    ).resolves.toMatchObject({ nodes: [], edges: [] });
    await expect(
      store.getOrganizationMemoryGraph({ agentId: member.binding.agentId, kind: "group" }),
    ).resolves.toMatchObject({ nodes: [], edges: [], stats: { totalPages: 0 } });
    store.close();
  });

  it("orders, deduplicates, and caps nodes and edges deterministically", async () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-org-graph-cap-"));
    directories.push(directory);
    const databasePath = join(directory, "control.sqlite");
    const store = new SqliteControlPlaneStore({
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["admin"],
      idFactory: ids(),
    });
    const admin = await activeUser(store, "admin", 10);
    const team = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "team",
      name: "Company",
      createdAt: 20,
    });
    const group = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "Platform",
      parentScopeId: team.id,
      createdAt: 21,
    });
    const part = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Runtime",
      parentScopeId: group.id,
      createdAt: 22,
    });
    await store.searchOrganizationMemory({ agentId: admin.binding.agentId, query: "seed" });
    const pageIds = Array.from(
      { length: 501 },
      (_, index) => `page-${String(index).padStart(3, "0")}`,
    );
    const db = new DatabaseSync(databasePath);
    for (const id of pageIds) {
      insertPage(db, {
        id,
        scopeKind: "part",
        scopeId: part.id,
        provenance: { backlinks: pageIds.slice(0, 10) },
      });
    }
    db.close();

    const first = await store.getOrganizationMemoryGraph({
      agentId: admin.binding.agentId,
      kind: "part",
    });
    const second = await store.getOrganizationMemoryGraph({
      agentId: admin.binding.agentId,
      kind: "part",
    });
    expect(first).toEqual(second);
    expect(first.nodes).toHaveLength(500);
    expect(first.edges).toHaveLength(2_000);
    expect(first.stats).toMatchObject({
      totalPages: 501,
      totalNodes: 500,
      truncated: true,
      partial: false,
    });
    expect(first.nodes.map((node) => node.id)).toEqual(
      first.nodes.map((node) => node.id).toSorted(),
    );
    expect(first.edges).toEqual(
      first.edges.toSorted(
        (left, right) =>
          (left.source < right.source ? -1 : left.source > right.source ? 1 : 0) ||
          (left.target < right.target ? -1 : left.target > right.target ? 1 : 0),
      ),
    );
    store.close();
  });
});
