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
    const partC = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Other readable Part",
      parentScopeId: groupA.id,
      createdAt: 35,
    });
    const groupLeader = await activeUser(store, "group-leader", 36);
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: groupA.id,
      userId: groupLeader.user.id,
      role: "leader",
      reason: "Synthetic oversight",
      changedAt: 39,
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
    for (let index = 0; index < 501; index++) {
      insertPage(db, { id: `other-readable-${index}`, scopeKind: "part", scopeId: partC.id });
    }
    db.close();

    const selected = await store.getOrganizationMemoryGraph({
      agentId: groupLeader.binding.agentId,
      kind: "part",
      scopeId: partA.id,
    });
    expect(selected.scopeId).toBe(partA.id);
    expect(selected.nodes.map((node) => node.path)).toEqual([
      "organization/part/a-source",
      "organization/part/b-target",
    ]);
    expect(selected.stats).toEqual({
      totalPages: 2,
      totalNodes: 2,
      totalEdges: 1,
      truncated: false,
      partial: false,
    });
    const overview = await store.getOrganizationMemoryGraph({
      agentId: groupLeader.binding.agentId,
      kind: "part",
    });
    expect(overview.stats).toMatchObject({ totalPages: 503, totalNodes: 500, truncated: true });
    expect(overview.scopeId).toBeUndefined();
    const inventory = await store.getOrganizationMemoryLifecycle(groupLeader.binding.agentId);
    expect(
      inventory.scopes.filter((scope) => scope.kind === "part").every((scope) => scope.canRead),
    ).toBe(true);
    const teamLeader = await activeUser(store, "team-leader", 41);
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: team.id,
      userId: teamLeader.user.id,
      role: "leader",
      reason: "Synthetic delegated authority",
      changedAt: 44,
    });
    const teamInventory = await store.getOrganizationMemoryLifecycle(teamLeader.binding.agentId);
    expect(teamInventory.scopes.find((scope) => scope.id === partA.id)).toMatchObject({
      canRead: false,
      canAdminister: true,
    });
    await expect(
      store.getOrganizationMemoryGraph({
        agentId: teamLeader.binding.agentId,
        kind: "part",
        scopeId: partA.id,
      }),
    ).rejects.toThrow("selected graph scope is unavailable");
    const groupMember = await activeUser(store, "group-member", 45);
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: groupA.id,
      userId: groupMember.user.id,
      role: "member",
      reason: "Synthetic Group audience",
      changedAt: 48,
    });
    const memberInventory = await store.getOrganizationMemoryLifecycle(groupMember.binding.agentId);
    expect(memberInventory.scopes.map((scope) => [scope.kind, scope.canRead])).toEqual(
      expect.arrayContaining([
        ["global", true],
        ["team", true],
        ["group", true],
      ]),
    );
    expect(memberInventory.scopes.some((scope) => scope.kind === "part")).toBe(false);
    expect(
      (
        await store.getOrganizationMemoryGraph({
          agentId: groupMember.binding.agentId,
          kind: "group",
          scopeId: groupA.id,
        })
      ).nodes.map((node) => node.path),
    ).toEqual(["organization/group/group-visible"]);
    const teamClaim = await store.publishOrganizationMemoryDirect({
      agentId: admin.binding.agentId,
      sourceKind: "personal",
      sourceClaimId: "wiki/team-audience.md",
      targetKind: "team",
      targetScopeId: team.id,
      proposedText: "Team audience",
      evidence: [],
      reason: "Synthetic audience",
      publishedAt: 49,
    });
    const globalTarget = await store.publishOrganizationMemoryDirect({
      agentId: admin.binding.agentId,
      sourceKind: "personal",
      sourceClaimId: "wiki/global-audience.md",
      targetKind: "global",
      proposedText: "Global audience",
      evidence: [],
      reason: "Synthetic audience",
      publishedAt: 49,
    });
    const globalInput = {
      agentId: admin.binding.agentId,
      sourceKind: "team" as const,
      sourceClaimId: teamClaim.targetClaimId!,
      expectedSourceRevision: 1,
      targetKind: "global" as const,
      proposedText: `Public [[organization/global/${globalTarget.targetClaimId!}]]`,
    };
    const globalPreview = await store.previewOrganizationMemoryPromotionReferences(globalInput);
    const globalSource = await store.publishOrganizationMemoryDirect({
      ...globalInput,
      expectedReferencesFingerprint: globalPreview.references!.fingerprint,
      evidence: [],
      reason: "Synthetic global reference",
      publishedAt: 49,
    });
    const globalGraph = await store.getOrganizationMemoryGraph({
      agentId: groupMember.binding.agentId,
      kind: "global",
    });
    expect(globalGraph.stats.totalPages).toBe(2);
    expect(globalGraph.edges).toContainEqual(
      expect.objectContaining({
        type: "reference",
        source: `organization:global:${globalSource.targetClaimId!}`,
        target: `organization:global:${globalTarget.targetClaimId!}`,
      }),
    );
    expect(
      (
        await store.getOrganizationMemoryGraph({
          agentId: groupMember.binding.agentId,
          kind: "team",
          scopeId: team.id,
        })
      ).nodes.map((node) => node.path),
    ).toEqual([`organization/team/${teamClaim.targetClaimId!}`]);
    expect(
      inventory.scopes
        .filter((scope) => scope.kind === "part")
        .map(({ id }) => {
          if (!id) {
            throw new Error("Part fixture must have a scope ID");
          }
          return id;
        })
        .toSorted(),
    ).toEqual([partA.id, partC.id].toSorted());
    for (const scopeId of [partB.id, groupA.id, "missing-scope"]) {
      await expect(
        store.getOrganizationMemoryGraph({
          agentId: groupLeader.binding.agentId,
          kind: "part",
          scopeId,
        }),
      ).rejects.toThrow("selected graph scope is unavailable");
    }

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
    const document = await store.getOrganizationMemory({
      agentId: member.binding.agentId,
      path: `organization/group/${approvedGroup.targetClaimId!}`,
      lineCount: 200,
    });
    expect(document?.verification).toEqual(
      verified.nodes.find((node) => node.path.endsWith(approvedGroup.targetClaimId!))?.verification,
    );
    expect(document?.totalLines).toBeGreaterThan(0);
    expect(document?.textTruncated).toBe(false);
    await expect(
      store.getOrganizationMemory({
        agentId: groupLeader.binding.agentId,
        path: "organization/part/sibling-hidden",
      }),
    ).resolves.toBeNull();
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
    await expect(
      store.getOrganizationMemoryGraph({
        agentId: member.binding.agentId,
        kind: "part",
        scopeId: partA.id,
      }),
    ).rejects.toThrow("selected graph scope is unavailable");
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
      store.getOrganizationMemoryGraph({
        agentId: groupLeader.binding.agentId,
        kind: "part",
        scopeId: partA.id,
      }),
    ).rejects.toThrow("selected graph scope is unavailable");
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
    const emptyPart = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Empty Part",
      parentScopeId: group.id,
      createdAt: 23,
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
    db.prepare("UPDATE organization_memory_pages SET content = ? WHERE id = ?").run(
      `${"x".repeat(70_000)}\nsecond line\nthird line`,
      pageIds[0]!,
    );
    db.close();

    const excerpt = await store.getOrganizationMemory({
      agentId: admin.binding.agentId,
      path: `organization/part/${pageIds[0]!}`,
      lineCount: 200,
    });
    expect(excerpt).toMatchObject({ totalLines: 3, lineCount: 3, textTruncated: true });
    expect(excerpt?.content.length).toBe(64 * 1024);
    await expect(
      store.getOrganizationMemory({
        agentId: admin.binding.agentId,
        path: `organization/part/${pageIds[0]!}`,
        fromLine: 2,
        lineCount: 1,
      }),
    ).resolves.toMatchObject({
      content: "second line",
      totalLines: 3,
      fromLine: 2,
      lineCount: 1,
      textTruncated: false,
    });

    await expect(
      store.getOrganizationMemoryGraph({
        agentId: admin.binding.agentId,
        kind: "part",
        scopeId: emptyPart.id,
      }),
    ).resolves.toEqual({
      kind: "part",
      scopeId: emptyPart.id,
      nodes: [],
      edges: [],
      stats: { totalPages: 0, totalNodes: 0, totalEdges: 0, truncated: false, partial: false },
    });

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
