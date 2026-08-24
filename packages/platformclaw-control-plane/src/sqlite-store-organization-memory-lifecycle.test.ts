import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlPlaneIdFactory } from "./contracts.js";
import { PLATFORMCLAW_CONTROL_SCHEMA_VERSION } from "./sqlite-schema.js";
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

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("organization memory promotion lifecycle", () => {
  it("rechecks submitter and reviewer authority after personal Wiki resolution", async () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-memory-promotion-race-"));
    directories.push(directory);
    let blocked: { started: () => void; wait: Promise<void> } | null = null;
    const store = new SqliteControlPlaneStore({
      databasePath: join(directory, "control.sqlite"),
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["admin"],
      idFactory: ids(),
      resolvePersonalOrganizationMemorySource: async ({ lookup }) => {
        blocked?.started();
        await blocked?.wait;
        return { claimId: lookup, revision: 1 };
      },
    });
    const admin = await activeUser(store, "admin", 10);
    const member = await activeUser(store, "member", 20);
    const team = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "team",
      name: "Company",
      createdAt: 29,
    });
    const group = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "Platform",
      parentScopeId: team.id,
      createdAt: 30,
    });
    const part = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Runtime",
      parentScopeId: group.id,
      createdAt: 31,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: group.id,
      userId: admin.user.id,
      role: "leader",
      reason: "test assignment",
      changedAt: 32,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: part.id,
      userId: member.user.id,
      role: "member",
      reason: "test assignment",
      changedAt: 33,
    });
    let releaseSubmit!: () => void;
    let markSubmitStarted!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      markSubmitStarted = resolve;
    });
    blocked = {
      started: markSubmitStarted,
      wait: new Promise<void>((resolve) => {
        releaseSubmit = resolve;
      }),
    };
    const racedSubmit = store.submitOrganizationMemoryPromotion({
      agentId: member.binding.agentId,
      sourceKind: "personal",
      sourceClaimId: "runbooks/race.md",
      targetKind: "part",
      targetScopeId: part.id,
      proposedText: "Race-safe policy",
      evidence: [],
      reason: "race proof",
      submittedAt: 40,
    });
    await submitStarted;
    await store.removeManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: part.id,
      userId: member.user.id,
      changedAt: 41,
    });
    releaseSubmit();
    await expect(racedSubmit).rejects.toThrow("target scope is not available");
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: part.id,
      userId: member.user.id,
      role: "member",
      reason: "test assignment",
      changedAt: 42,
    });
    blocked = null;
    const request = await store.submitOrganizationMemoryPromotion({
      agentId: member.binding.agentId,
      sourceKind: "personal",
      sourceClaimId: "runbooks/race.md",
      targetKind: "part",
      targetScopeId: part.id,
      proposedText: "Race-safe policy",
      evidence: [],
      reason: "race proof",
      submittedAt: 43,
    });
    let releaseReview!: () => void;
    let markReviewStarted!: () => void;
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve;
    });
    blocked = {
      started: markReviewStarted,
      wait: new Promise<void>((resolve) => {
        releaseReview = resolve;
      }),
    };
    const racedDecision = store.decideOrganizationMemoryPromotion({
      agentId: admin.binding.agentId,
      requestId: request.id,
      decision: "approve",
      reason: "race proof",
      decidedAt: 44,
    });
    await reviewStarted;
    await store.removeManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: group.id,
      userId: admin.user.id,
      changedAt: 45,
    });
    releaseReview();
    await expect(racedDecision).rejects.toThrow("promotion approval authority required");
    store.close();
  });

  it("enforces ordered promotion, immutable approval, retirement, purge, and authorization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-memory-promotion-"));
    directories.push(directory);
    const databasePath = join(directory, "control.sqlite");
    let personalRevision = 1;
    const store = new SqliteControlPlaneStore({
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["admin"],
      idFactory: ids(),
      resolvePersonalOrganizationMemorySource: async ({ lookup }) => ({
        claimId: lookup,
        revision: personalRevision,
      }),
    });
    const admin = await activeUser(store, "admin", 10);
    const member = await activeUser(store, "member", 20);
    const outsider = await activeUser(store, "outsider", 30);
    const team = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "team",
      name: "Company",
      createdAt: 39,
    });
    const group = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "Platform",
      parentScopeId: team.id,
      createdAt: 40,
    });
    const part = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Runtime",
      parentScopeId: group.id,
      createdAt: 41,
    });
    const siblingGroup = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "Product",
      parentScopeId: team.id,
      createdAt: 41,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: group.id,
      userId: admin.user.id,
      role: "leader",
      reason: "test assignment",
      changedAt: 42,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: part.id,
      userId: member.user.id,
      role: "member",
      reason: "test assignment",
      changedAt: 43,
    });

    const personal = await store.submitOrganizationMemoryPromotion({
      agentId: member.binding.agentId,
      sourceKind: "personal",
      sourceClaimId: "personal-runbook-v1",
      expectedSourceRevision: 1,
      targetKind: "part",
      targetScopeId: part.id,
      proposedText: "# Runtime recovery\nRestart the worker after draining jobs.",
      evidence: ["Incident 42"],
      reason: "Reusable operating procedure",
      submittedAt: 50,
    });
    expect(personal.status).toBe("pending");
    await expect(
      store.decideOrganizationMemoryPromotion({
        agentId: member.binding.agentId,
        requestId: personal.id,
        decision: "approve",
        reason: "unauthorized",
        decidedAt: 51,
      }),
    ).rejects.toThrow("promotion approval authority required");
    await store.removeManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: part.id,
      userId: member.user.id,
      changedAt: 51,
    });
    await expect(
      store.decideOrganizationMemoryPromotion({
        agentId: admin.binding.agentId,
        requestId: personal.id,
        decision: "approve",
        reason: "membership changed",
        decidedAt: 51,
      }),
    ).rejects.toThrow("requester is no longer a member");
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: part.id,
      userId: member.user.id,
      role: "member",
      reason: "test assignment",
      changedAt: 51,
    });
    personalRevision = 2;
    await expect(
      store.decideOrganizationMemoryPromotion({
        agentId: admin.binding.agentId,
        requestId: personal.id,
        decision: "approve",
        reason: "stale source",
        decidedAt: 52,
      }),
    ).rejects.toThrow("personal Wiki source revision is no longer active");
    personalRevision = 1;
    const approvedPart = await store.decideOrganizationMemoryPromotion({
      agentId: admin.binding.agentId,
      requestId: personal.id,
      decision: "approve",
      reason: "Verified",
      decidedAt: 52,
    });
    expect(approvedPart.status).toBe("approved");
    await expect(
      store.decideOrganizationMemoryPromotion({
        agentId: admin.binding.agentId,
        requestId: personal.id,
        decision: "reject",
        reason: "changed mind",
        decidedAt: 53,
      }),
    ).rejects.toThrow("immutable decision");

    const partClaim = approvedPart.targetClaimId!;
    await expect(
      store.submitOrganizationMemoryPromotion({
        agentId: admin.binding.agentId,
        sourceKind: "part",
        sourceClaimId: partClaim,
        expectedSourceRevision: 1,
        targetKind: "group",
        targetScopeId: siblingGroup.id,
        proposedText: "Cross-group copy",
        evidence: ["none"],
        reason: "invalid sibling target",
        submittedAt: 59,
      }),
    ).rejects.toThrow("promotion must advance");
    expect(
      await store.searchOrganizationMemory({
        agentId: member.binding.agentId,
        query: "recovery",
      }),
    ).toHaveLength(1);
    expect(
      await store.searchOrganizationMemory({
        agentId: outsider.binding.agentId,
        query: "recovery",
      }),
    ).toHaveLength(0);

    const groupRequest = await store.submitOrganizationMemoryPromotion({
      agentId: admin.binding.agentId,
      sourceKind: "part",
      sourceClaimId: partClaim,
      expectedSourceRevision: 1,
      targetKind: "group",
      targetScopeId: group.id,
      proposedText: "# Platform recovery\nDrain jobs before restart.",
      evidence: ["Approved Runtime claim"],
      reason: "Applies to the parent group",
      submittedAt: 60,
    });
    const approvedGroup = await store.decideOrganizationMemoryPromotion({
      agentId: admin.binding.agentId,
      requestId: groupRequest.id,
      decision: "approve",
      reason: "Verified",
      decidedAt: 61,
    });
    const globalRequest = await store.submitOrganizationMemoryPromotion({
      agentId: admin.binding.agentId,
      sourceKind: "group",
      sourceClaimId: approvedGroup.targetClaimId!,
      expectedSourceRevision: 1,
      targetKind: "global",
      proposedText: "# Company recovery\nDrain jobs before service restart.",
      evidence: ["Approved Platform claim"],
      reason: "Company-wide standard",
      submittedAt: 70,
    });
    await store.setUserGlobalRole({
      actorUserId: admin.user.id,
      targetUserId: outsider.user.id,
      role: "admin",
      changedAt: 70,
    });
    const adminWithoutMembership = await store.getOrganizationMemoryLifecycle(
      outsider.binding.agentId,
    );
    expect(adminWithoutMembership.claims.map((claim) => claim.id)).not.toContain(partClaim);
    expect(adminWithoutMembership.claims.map((claim) => claim.id)).not.toContain(
      approvedGroup.targetClaimId,
    );
    const approvedGlobal = await store.decideOrganizationMemoryPromotion({
      agentId: outsider.binding.agentId,
      requestId: globalRequest.id,
      decision: "approve",
      reason: "PlatformClaw administrator approval",
      decidedAt: 71,
    });
    const globalClaim = approvedGlobal.targetClaimId!;
    expect(
      await store.searchOrganizationMemory({
        agentId: outsider.binding.agentId,
        query: "Company recovery",
      }),
    ).toHaveLength(1);

    await expect(
      store.retireOrganizationMemoryClaim({
        agentId: member.binding.agentId,
        claimId: globalClaim,
        reason: "not mine",
        retiredAt: 80,
      }),
    ).rejects.toThrow("retirement authority required");
    const retired = await store.retireOrganizationMemoryClaim({
      agentId: admin.binding.agentId,
      claimId: globalClaim,
      reason: "Superseded",
      retiredAt: 81,
    });
    expect(retired.status).toBe("retired");
    const auditBeforePurge = new DatabaseSync(databasePath);
    expect(
      auditBeforePurge
        .prepare("SELECT proposed_text FROM organization_memory_promotion_requests WHERE id = ?")
        .get(globalRequest.id),
    ).toEqual({ proposed_text: "# Company recovery\nDrain jobs before service restart." });
    auditBeforePurge.close();
    expect(
      await store.searchOrganizationMemory({
        agentId: outsider.binding.agentId,
        query: "Company recovery",
      }),
    ).toHaveLength(0);
    await expect(
      store.purgeOrganizationMemoryClaim({
        agentId: member.binding.agentId,
        claimId: globalClaim,
        reason: "privacy",
        purgedAt: 82,
      }),
    ).rejects.toThrow("active administrator required");
    const purged = await store.purgeOrganizationMemoryClaim({
      agentId: admin.binding.agentId,
      claimId: globalClaim,
      reason: "Privacy erasure request",
      purgedAt: 83,
    });
    expect(purged).toMatchObject({ status: "purged", text: "" });

    const archivedPart = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Archived",
      parentScopeId: siblingGroup.id,
      createdAt: 90,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: archivedPart.id,
      userId: member.user.id,
      role: "member",
      reason: "test assignment",
      changedAt: 91,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: archivedPart.id,
      userId: admin.user.id,
      role: "leader",
      reason: "test assignment",
      changedAt: 91,
    });
    const archivedPublishedRequest = await store.submitOrganizationMemoryPromotion({
      agentId: member.binding.agentId,
      sourceKind: "personal",
      sourceClaimId: "wiki/archived-published.md",
      targetKind: "part",
      targetScopeId: archivedPart.id,
      proposedText: "Retire with the archived scope",
      evidence: ["scope lifecycle"],
      reason: "archive owner regression",
      submittedAt: 91,
    });
    const archivedPublished = await store.decideOrganizationMemoryPromotion({
      agentId: admin.binding.agentId,
      requestId: archivedPublishedRequest.id,
      decision: "approve",
      reason: "Verified before archive",
      decidedAt: 92,
    });
    const archivedRequest = await store.submitOrganizationMemoryPromotion({
      agentId: member.binding.agentId,
      sourceKind: "personal",
      sourceClaimId: "personal-archived-target",
      expectedSourceRevision: 1,
      targetKind: "part",
      targetScopeId: archivedPart.id,
      proposedText: "Must not publish",
      evidence: ["scope lifecycle"],
      reason: "archive race regression",
      submittedAt: 92,
    });
    await store.archiveManagedScope({
      actorUserId: admin.user.id,
      scopeId: archivedPart.id,
      reason: "retire archived part",
      archivedAt: 93,
    });
    const archivedLifecycle = await store.getOrganizationMemoryLifecycle(admin.binding.agentId);
    expect(archivedLifecycle.claims).toContainEqual(
      expect.objectContaining({ id: archivedPublished.targetClaimId, status: "retired" }),
    );
    await expect(
      store.purgeOrganizationMemoryClaim({
        agentId: admin.binding.agentId,
        claimId: archivedPublished.targetClaimId!,
        reason: "Archived-scope privacy purge",
        purgedAt: 93,
      }),
    ).resolves.toMatchObject({ status: "purged" });
    await expect(
      store.decideOrganizationMemoryPromotion({
        agentId: admin.binding.agentId,
        requestId: archivedRequest.id,
        decision: "approve",
        reason: "stale review",
        decidedAt: 94,
      }),
    ).rejects.toThrow("immutable decision");
    const archivedRequesterView = await store.getOrganizationMemoryLifecycle(
      member.binding.agentId,
    );
    expect(archivedRequesterView.submitted).toContainEqual(
      expect.objectContaining({
        id: archivedRequest.id,
        status: "rejected",
        decisionReason: "Owning target scope archived",
      }),
    );

    const cascadeGroup = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "Cascade",
      parentScopeId: team.id,
      createdAt: 95,
    });
    const cascadePart = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Child",
      parentScopeId: cascadeGroup.id,
      createdAt: 96,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: cascadePart.id,
      userId: member.user.id,
      role: "member",
      reason: "test assignment",
      changedAt: 97,
    });
    const cascadeRequest = await store.submitOrganizationMemoryPromotion({
      agentId: member.binding.agentId,
      sourceKind: "personal",
      sourceClaimId: "wiki/cascade.md",
      targetKind: "part",
      targetScopeId: cascadePart.id,
      proposedText: "Reject with parent archive",
      evidence: [],
      reason: "group cascade regression",
      submittedAt: 98,
    });
    await store.archiveManagedScope({
      actorUserId: admin.user.id,
      scopeId: cascadeGroup.id,
      reason: "retire cascade group",
      archivedAt: 99,
    });
    expect(
      (await store.getOrganizationMemoryLifecycle(member.binding.agentId)).submitted,
    ).toContainEqual(expect.objectContaining({ id: cascadeRequest.id, status: "rejected" }));

    const lifecycle = await store.getOrganizationMemoryLifecycle(admin.binding.agentId);
    expect(lifecycle.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "global", canAdminister: true }),
        expect.objectContaining({ kind: "group", id: group.id, canAdminister: true }),
      ]),
    );
    expect(lifecycle.claims.some((claim) => claim.id === globalClaim)).toBe(false);
    expect(lifecycle.submitted.map((request) => request.status)).toContain("approved");
    const db = new DatabaseSync(databasePath);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
    });
    expect(
      db
        .prepare(
          "SELECT claim_text, evidence_json, status FROM organization_memory_claims WHERE id = ?",
        )
        .get(globalClaim),
    ).toEqual({ claim_text: "", evidence_json: "[]", status: "purged" });
    expect(
      db
        .prepare(
          "SELECT proposed_text, evidence_json FROM organization_memory_promotion_requests WHERE id = ?",
        )
        .get(globalRequest.id),
    ).toEqual({ proposed_text: "[purged]", evidence_json: "[]" });
    const cloneRequest = db.prepare(`
      INSERT INTO organization_memory_promotion_requests (
        id, source_kind, source_scope_id, source_claim_id, source_revision,
        target_kind, target_scope_id, proposed_text, evidence_json, reason,
        requested_by_user_id, created_at
      )
      SELECT ?, source_kind, source_scope_id, source_claim_id, source_revision,
        target_kind, target_scope_id, proposed_text, evidence_json, reason,
        requested_by_user_id, ?
      FROM organization_memory_promotion_requests WHERE id = ?
    `);
    for (let index = 0; index < 205; index += 1) {
      cloneRequest.run(`bulk-${index}`, 1_000 + index, personal.id);
    }
    const firstPage = await store.getOrganizationMemoryLifecycle(member.binding.agentId);
    expect(firstPage.submitted).toHaveLength(200);
    expect(firstPage.next?.submitted).toBe(200);
    const secondPage = await store.getOrganizationMemoryLifecycle(member.binding.agentId, {
      submitted: firstPage.next?.submitted,
    });
    expect(secondPage.submitted).toHaveLength(9);
    const partProvenance = JSON.parse(
      (
        db
          .prepare("SELECT provenance_json FROM organization_memory_pages WHERE id = ?")
          .get(partClaim) as { provenance_json: string }
      ).provenance_json,
    ) as { backlinks: string[]; relatedPages: string[]; report: Record<string, number> };
    expect(partProvenance).toMatchObject({
      backlinks: [approvedGroup.targetClaimId],
      relatedPages: [approvedGroup.targetClaimId],
      report: { activeBacklinks: 1, activeRelatedPages: 1 },
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM control_audit_events WHERE event_type LIKE 'organization-memory.%'",
        )
        .get(),
    ).toEqual({ count: 16 });
    expect(() =>
      db
        .prepare(
          "UPDATE organization_memory_promotion_decisions SET reason = 'rewritten' WHERE request_id = ?",
        )
        .run(personal.id),
    ).toThrow("immutable");
    db.close();
    store.close();
  });
});
