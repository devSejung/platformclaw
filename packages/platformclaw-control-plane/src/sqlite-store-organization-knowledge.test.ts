import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { OrganizationKnowledgeService } from "./organization-knowledge-service.js";
import {
  cleanup,
  fixture,
  analysis,
  generateSuccess,
} from "./sqlite-store-organization-knowledge.test-helpers.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

describe("organization knowledge owner", () => {
  it("lets Group leaders read only their own Part knowledge and reports without report mutation rights", async () => {
    const f = await fixture();
    await generateSuccess(f);
    const snapshot = (
      await f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.ancestor.agentId,
        scopeId: f.part.id,
      })
    ).selected!;
    expect(snapshot.scope.capabilities).toEqual({
      canReadReport: true,
      canGenerateReport: false,
      canReviewProposals: false,
      canApplyProposals: false,
    });
    expect(snapshot.proposals[0]!.sourceClaims[0]!.evidence).toEqual([
      "Synthetic approved example",
    ]);
    expect(snapshot.proposals[0]!.sourceClaims[0]!.evidenceStatus).toBe("available");
    expect(
      await f.store.searchOrganizationMemory({ agentId: f.ancestor.agentId, query: "alpha" }),
    ).toHaveLength(1);
    expect(
      (
        await f.store.getOrganizationMemory({
          agentId: f.ancestor.agentId,
          path: `organization/part/${f.claims[0]}`,
        })
      )?.content,
    ).toContain("alpha");
    const graph = await f.store.getOrganizationMemoryGraph({
      agentId: f.ancestor.agentId,
      kind: "part",
    });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([
      expect.objectContaining({
        type: "comparison",
        kind: "condition-difference",
        inputStatus: "current",
        reviewStatus: "pending",
      }),
    ]);
    const otherGroup = await f.store.createManagedScope({
      actorUserId: f.admin.userId,
      kind: "group",
      name: "Other Group",
      parentScopeId: f.team.id,
      createdAt: 110,
    });
    const otherPart = await f.store.createManagedScope({
      actorUserId: f.admin.userId,
      kind: "part",
      name: "Other Part",
      parentScopeId: otherGroup.id,
      createdAt: 111,
    });
    const hidden = await f.store.publishOrganizationMemoryDirect({
      agentId: f.admin.agentId,
      sourceKind: "personal",
      sourceClaimId: "wiki/other.md",
      targetKind: "part",
      targetScopeId: otherPart.id,
      proposedText: "Other-private conditions and evidence",
      evidence: ["Other-private evidence"],
      reason: "Synthetic sibling",
      publishedAt: 112,
    });
    expect(
      await f.store.searchOrganizationMemory({
        agentId: f.ancestor.agentId,
        query: "Other-private",
      }),
    ).toEqual([]);
    expect(
      await f.store.getOrganizationMemory({
        agentId: f.ancestor.agentId,
        path: `organization/part/${hidden.targetClaimId}`,
      }),
    ).toBeNull();
    await expect(
      f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.ancestor.agentId,
        scopeId: otherPart.id,
      }),
    ).rejects.toThrow();
    expect(
      JSON.stringify(
        await f.store.getOrganizationMemoryGraph({ agentId: f.ancestor.agentId, kind: "part" }),
      ),
    ).not.toContain("Other-private");
    const proposal = snapshot.proposals[0]!;
    await expect(
      f.store.enqueueOrganizationKnowledge({
        agentId: f.ancestor.agentId,
        scopeId: f.part.id,
        requestId: "oversight-generate",
        now: 113,
      }),
    ).rejects.toThrow();
    await expect(
      f.store.decideOrganizationKnowledgeProposal({
        agentId: f.ancestor.agentId,
        scopeId: f.part.id,
        proposalId: proposal.id,
        expectedRevision: 0,
        decision: "approve",
        reason: "Read is not review",
        now: 114,
      }),
    ).rejects.toThrow();
    await expect(
      f.store.applyOrganizationKnowledgeProposal({
        agentId: f.ancestor.agentId,
        scopeId: f.part.id,
        proposalId: proposal.id,
        expectedRevision: 0,
        survivorClaimId: f.claims[0]!,
        proposedText: "Not authorized",
        reason: "Read is not apply",
        now: 115,
      }),
    ).rejects.toThrow();
    for (const [account, role, scopeId] of [
      ["group-member", "member", f.group.id],
      ["team-leader", "leader", f.team.id],
    ] as const) {
      const actor = await f.actor(account);
      await f.membership(actor.userId, role, scopeId);
      expect(
        (await f.store.getOrganizationMemoryGraph({ agentId: actor.agentId, kind: "part" })).nodes,
      ).toEqual([]);
      await expect(
        f.store.getOrganizationKnowledgeSnapshot({ agentId: actor.agentId, scopeId: f.part.id }),
      ).rejects.toThrow();
    }
    await f.store.archiveManagedScope({
      actorUserId: f.admin.userId,
      scopeId: f.group.id,
      reason: "Synthetic archive",
      archivedAt: 116,
    });
    expect(
      (await f.store.getOrganizationMemoryGraph({ agentId: f.ancestor.agentId, kind: "part" }))
        .nodes,
    ).toEqual([]);
    expect(
      await f.store.searchOrganizationMemory({ agentId: f.ancestor.agentId, query: "alpha" }),
    ).toEqual([]);
    await expect(
      f.store.getOrganizationKnowledgeSnapshot({ agentId: f.ancestor.agentId, scopeId: f.part.id }),
    ).rejects.toThrow();
  });

  it("projects current typed inferences with human review status and excludes rejected, uncertain, and stale pairs", async () => {
    const f = await fixture();
    await generateSuccess(f);
    const graph = () =>
      f.store.getOrganizationMemoryGraph({ agentId: f.leader.agentId, kind: "part" });
    const proposal = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!.proposals[0]!;
    await f.store.decideOrganizationKnowledgeProposal({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      proposalId: proposal.id,
      expectedRevision: 0,
      decision: "keep",
      reason: "Keep distinct conditions",
      now: 103,
    });
    expect((await graph()).edges[0]).toMatchObject({ type: "comparison", reviewStatus: "kept" });
    const db = new DatabaseSync(f.options.databasePath);
    db.prepare("UPDATE organization_memory_claims SET revision = revision + 1 WHERE id = ?").run(
      f.claims[0]!,
    );
    expect((await graph()).edges).toEqual([]);
    db.close();
    const rejected = await fixture();
    await generateSuccess(rejected);
    const rejectedProposal = (
      await rejected.store.getOrganizationKnowledgeSnapshot({ agentId: rejected.leader.agentId })
    ).selected!.proposals[0]!;
    await rejected.store.decideOrganizationKnowledgeProposal({
      agentId: rejected.leader.agentId,
      scopeId: rejected.part.id,
      proposalId: rejectedProposal.id,
      expectedRevision: 0,
      decision: "reject",
      reason: "Unsupported relation",
      now: 103,
    });
    expect(
      (
        await rejected.store.getOrganizationMemoryGraph({
          agentId: rejected.leader.agentId,
          kind: "part",
        })
      ).edges,
    ).toEqual([]);
    const uncertain = await fixture();
    await uncertain.store.enqueueOrganizationKnowledge({
      agentId: uncertain.leader.agentId,
      scopeId: uncertain.part.id,
      requestId: "uncertain",
      now: 100,
    });
    const job = await uncertain.store.claimOrganizationKnowledgeJob({
      owner: "uncertain",
      now: 101,
    });
    const result = analysis(job!.input!);
    result.comparisons[0]!.kind = "insufficient-evidence";
    await uncertain.store.finishOrganizationKnowledgeJob({
      jobId: job!.jobId,
      owner: "uncertain",
      now: 102,
      analysis: result,
    });
    expect(
      (
        await uncertain.store.getOrganizationMemoryGraph({
          agentId: uncertain.leader.agentId,
          kind: "part",
        })
      ).edges,
    ).toEqual([]);
  });

  it("keeps evidence absence, empty evidence, and bounded truncation distinct without reading private sources", async () => {
    const f = await fixture();
    await generateSuccess(f);
    const db = new DatabaseSync(f.options.databasePath);
    const evidence = (
      await f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.ancestor.agentId,
        scopeId: f.part.id,
      })
    ).selected!.proposals[0]!.sourceClaims[0]!;
    db.prepare("UPDATE organization_memory_claims SET evidence_json = ? WHERE id = ?").run(
      JSON.stringify([]),
      evidence.id,
    );
    let source = (
      await f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.ancestor.agentId,
        scopeId: f.part.id,
      })
    ).selected!.proposals[0]!.sourceClaims[0]!;
    expect(source).toMatchObject({
      evidence: [],
      evidenceStatus: "available",
      evidenceTruncated: false,
    });
    db.prepare("UPDATE organization_memory_claims SET evidence_json = ? WHERE id = ?").run(
      JSON.stringify(["x".repeat(501)]),
      evidence.id,
    );
    source = (
      await f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.ancestor.agentId,
        scopeId: f.part.id,
      })
    ).selected!.proposals[0]!.sourceClaims[0]!;
    expect(source.evidence![0]).toHaveLength(500);
    expect(source.evidenceTruncated).toBe(true);
    db.prepare("UPDATE organization_memory_claims SET evidence_json = ? WHERE id = ?").run(
      "null",
      evidence.id,
    );
    source = (
      await f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.ancestor.agentId,
        scopeId: f.part.id,
      })
    ).selected!.proposals[0]!.sourceClaims[0]!;
    expect(source.evidenceStatus).toBe("unavailable");
    expect(source.evidence).toBeUndefined();
    db.prepare("UPDATE platform_users SET status = 'disabled' WHERE id = ?").run(f.ancestor.userId);
    await expect(
      f.store.getOrganizationMemoryGraph({ agentId: f.ancestor.agentId, kind: "part" }),
    ).rejects.toThrow();
    await expect(
      f.store.getOrganizationKnowledgeSnapshot({ agentId: f.ancestor.agentId, scopeId: f.part.id }),
    ).rejects.toThrow();
    db.close();
  });
  it("compares submitted share text without report jobs and prevents stale reviewed approval while preserving old entitlement", async () => {
    const f = await fixture();
    let calls = 0;
    const service = new OrganizationKnowledgeService(
      f.store,
      async (input) => {
        calls += 1;
        return analysis(input);
      },
      () => 100,
    );
    const request = await f.store.submitOrganizationMemoryPromotion({
      agentId: f.leader.agentId,
      sourceKind: "personal",
      sourceClaimId: "wiki/submitted.md",
      targetKind: "part",
      targetScopeId: f.part.id,
      proposedText: "Test condition gamma: perform a dry run.",
      evidence: ["Synthetic submitted evidence"],
      reason: "Synthetic submission",
      submittedAt: 10,
    });
    const oversightComparison = await service.comparePromotion({
      agentId: f.ancestor.agentId,
      requestId: request.id,
    });
    expect(oversightComparison.status).toBe("available");
    expect(oversightComparison.sourceClaims).toHaveLength(3);
    expect(oversightComparison.sourceClaims![0]!.evidence).toEqual([
      "Synthetic submitted evidence",
    ]);
    expect(calls).toBe(2);
    const comparison = await service.comparePromotion({
      agentId: f.secondLeader.agentId,
      requestId: request.id,
    });
    expect(comparison.status).toBe("available");
    expect(calls).toBe(2);
    await service.comparePromotion({ agentId: f.secondLeader.agentId, requestId: request.id });
    expect(calls).toBe(2);
    expect(
      (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId })).selected!
        .currentJob,
    ).toBeNull();
    await f.store.publishOrganizationMemoryDirect({
      agentId: f.admin.agentId,
      sourceKind: "personal",
      sourceClaimId: "wiki/another.md",
      targetKind: "part",
      targetScopeId: f.part.id,
      proposedText: "Test condition delta: perform a dry run.",
      evidence: ["Synthetic new evidence"],
      reason: "Synthetic intervening publication",
      publishedAt: 11,
    });
    await expect(
      f.store.decideOrganizationMemoryPromotion({
        agentId: f.secondLeader.agentId,
        requestId: request.id,
        decision: "approve",
        reason: "Synthetic stale review",
        expectedComparisonFingerprint: comparison.inputFingerprint,
        decidedAt: 12,
      }),
    ).rejects.toThrow("compare related knowledge again");
    expect(
      (await f.store.getOrganizationMemoryLifecycle(f.secondLeader.agentId)).reviewable.find(
        (entry) => entry.id === request.id,
      )!.relatedKnowledgeComparison!.status,
    ).toBe("stale");
    // Existing delegated promotion review authority remains independent of
    // the narrower direct-leader report mutation entitlement.
    await f.store.decideOrganizationMemoryPromotion({
      agentId: f.ancestor.agentId,
      requestId: request.id,
      decision: "approve",
      reason: "Existing entitlement",
      decidedAt: 13,
    });
    await service.close();
  });
  it("applies only explicit approved same-scope revisions atomically and retains exact approval history", async () => {
    const f = await fixture();
    await f.store.enqueueOrganizationKnowledge({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      requestId: "apply-report",
      now: 100,
    });
    const job = await f.store.claimOrganizationKnowledgeJob({ owner: "test-worker", now: 101 });
    const result = analysis(job!.input!);
    result.comparisons[0]!.kind = "enrichment";
    await f.store.finishOrganizationKnowledgeJob({
      jobId: job!.jobId,
      owner: "test-worker",
      now: 102,
      analysis: result,
    });
    const proposal = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!.proposals[0]!;
    const params = {
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      proposalId: proposal.id,
      expectedRevision: 1,
      survivorClaimId: f.claims[0]!,
      proposedText: "# Reviewed synthetic conditions\n\nPerform a dry run for alpha or beta.",
      reason: "Explicit synthetic approval",
      now: 104,
    };
    await expect(f.store.applyOrganizationKnowledgeProposal(params)).rejects.toThrow("approved");
    await f.store.decideOrganizationKnowledgeProposal({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      proposalId: proposal.id,
      expectedRevision: 0,
      decision: "approve",
      reason: "Review synthetic proposal",
      now: 103,
    });
    const attempts = await Promise.allSettled([
      f.store.applyOrganizationKnowledgeProposal(params),
      f.store.applyOrganizationKnowledgeProposal({ ...params, agentId: f.secondLeader.agentId }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const claims = (await f.store.getOrganizationMemoryLifecycle(f.leader.agentId)).claims;
    const survivor = claims.find((claim) => claim.id === f.claims[0])!;
    expect(survivor.text).toBe(params.proposedText);
    expect(survivor.revision).toBe(2);
    expect(survivor.revisionApproval).toEqual(
      expect.objectContaining({
        approvedByUserId: f.leader.userId,
        proposalId: proposal.id,
        approvedAt: 104,
      }),
    );
    expect(claims.find((claim) => claim.id === f.claims[1])!.status).toBe("retired");
    expect(
      await f.store.searchOrganizationMemory({ agentId: f.leader.agentId, query: "dry run" }),
    ).toHaveLength(1);
    const snapshot = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!;
    expect(snapshot.history.find((entry) => entry.decision === "apply")!.outcome).toEqual({
      claimId: survivor.id,
      revision: 2,
    });
    const db = new DatabaseSync(f.options.databasePath);
    const old = db
      .prepare(
        "SELECT payload_json FROM organization_memory_claim_revisions WHERE claim_id = ? AND revision = 1",
      )
      .get(survivor.id) as { payload_json: string };
    expect(JSON.parse(old.payload_json).claim_text).toBe(
      "Test condition alpha: perform a dry run.",
    );
    expect(
      db.prepare("SELECT count(*) AS total FROM organization_memory_claim_supersedes").get(),
    ).toEqual(expect.objectContaining({ total: 2 }));
    db.close();
  });
  it("preserves existing defer audit while disallowing new defer and keeping repeated pairs suppressed", async () => {
    const f = await fixture();
    await generateSuccess(f);
    const proposal = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!.proposals[0]!;
    await expect(
      f.store.decideOrganizationKnowledgeProposal({
        agentId: f.leader.agentId,
        scopeId: f.part.id,
        proposalId: proposal.id,
        expectedRevision: 0,
        decision: "defer" as "keep",
        reason: "Await synthetic evidence",
        now: 103,
      }),
    ).rejects.toThrow("decision must");
    const db = new DatabaseSync(f.options.databasePath);
    db.prepare(
      "INSERT INTO organization_knowledge_reviews(id,proposal_id,revision,decision,actor_user_id,reason,occurred_at) VALUES(?,?,1,'defer',?,?,103)",
    ).run("legacy-defer", proposal.id, f.leader.userId, "Await synthetic evidence");
    db.close();
    let snapshot = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!;
    expect(snapshot.proposals[0]!.status).toBe("pending");
    expect(snapshot.history[0]!.decision).toBe("defer");
    await f.store.decideOrganizationKnowledgeProposal({
      agentId: f.secondLeader.agentId,
      scopeId: f.part.id,
      proposalId: proposal.id,
      expectedRevision: 1,
      decision: "keep",
      reason: "Keep distinct synthetic knowledge",
      now: 104,
    });
    snapshot = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!;
    expect(snapshot.proposals).toEqual([]);
    expect(snapshot.history[0]!.proposal!.status).toBe("kept");
    expect(snapshot.history).toHaveLength(2);
    await expect(
      f.store.decideOrganizationKnowledgeProposal({
        agentId: f.leader.agentId,
        scopeId: f.part.id,
        proposalId: proposal.id,
        expectedRevision: 2,
        decision: "approve",
        reason: "Terminal pair",
        now: 105,
      }),
    ).rejects.toThrow("reviewable");
    await f.store.enqueueOrganizationKnowledge({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      requestId: "repeat-kept",
      force: true,
      now: 106,
    });
    const job = await f.store.claimOrganizationKnowledgeJob({ owner: "repeat-worker", now: 107 });
    await f.store.finishOrganizationKnowledgeJob({
      jobId: job!.jobId,
      owner: "repeat-worker",
      now: 108,
      analysis: analysis(job!.input!),
    });
    expect(
      (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId })).selected!
        .proposals,
    ).toHaveLength(0);
  });

  it("denies condition merges, stale reviews, revoked writes and archived reads", async () => {
    const f = await fixture();
    await generateSuccess(f);
    const proposal = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!.proposals[0]!;
    const review = {
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      proposalId: proposal.id,
      expectedRevision: 0,
      decision: "approve" as const,
      reason: "Synthetic review",
      now: 103,
    };
    await f.store.decideOrganizationKnowledgeProposal(review);
    const apply = {
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      proposalId: proposal.id,
      expectedRevision: 1,
      survivorClaimId: f.claims[0]!,
      proposedText: "Synthetic merge",
      reason: "Explicit review",
      now: 104,
    };
    await expect(f.store.applyOrganizationKnowledgeProposal(apply)).rejects.toThrow(
      "duplicate or enrichment",
    );
    await f.store.enqueueOrganizationKnowledge({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      requestId: "new-kind",
      force: true,
      now: 105,
    });
    const job = await f.store.claimOrganizationKnowledgeJob({ owner: "new-kind-worker", now: 106 });
    const result = analysis(job!.input!);
    result.comparisons[0]!.kind = "enrichment";
    await f.store.finishOrganizationKnowledgeJob({
      jobId: job!.jobId,
      owner: "new-kind-worker",
      now: 107,
      analysis: result,
    });
    const pending = (
      await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId })
    ).selected!.proposals.find((entry) => entry.kind === "enrichment")!;
    const db = new DatabaseSync(f.options.databasePath);
    db.prepare("UPDATE organization_memory_claims SET revision = revision + 1 WHERE id = ?").run(
      f.claims[0]!,
    );
    db.close();
    await expect(
      f.store.decideOrganizationKnowledgeProposal({ ...review, proposalId: pending.id, now: 108 }),
    ).rejects.toThrow("revision changed");
    await f.membership(f.leader.userId, "member");
    await expect(
      f.store.decideOrganizationKnowledgeProposal({ ...review, proposalId: pending.id, now: 109 }),
    ).rejects.toThrow();
    await expect(f.store.applyOrganizationKnowledgeProposal(apply)).rejects.toThrow();
    await f.store.archiveManagedScope({
      actorUserId: f.admin.userId,
      scopeId: f.part.id,
      reason: "Synthetic archive",
      archivedAt: 110,
    });
    await expect(
      f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.secondLeader.agentId,
        scopeId: f.part.id,
      }),
    ).rejects.toThrow();
  });

  it("requires exact target leader entitlement even for administrators and ancestor leaders", async () => {
    const f = await fixture();
    for (const actor of [f.admin]) {
      await expect(
        f.store.getOrganizationKnowledgeSnapshot({ agentId: actor.agentId, scopeId: f.part.id }),
      ).rejects.toThrow();
    }
    await f.membership(f.admin.userId, "member");
    await expect(
      f.store.getOrganizationKnowledgeSnapshot({ agentId: f.admin.agentId, scopeId: f.part.id }),
    ).rejects.toThrow();
    expect(
      (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId })).scopes.map(
        (scope) => scope.id,
      ),
    ).toEqual([f.part.id]);
    expect(
      (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.ancestor.agentId })).scopes.map(
        (scope) => scope.id,
      ),
    ).toEqual([f.group.id, f.part.id].toSorted());
  });

  it("atomically deduplicates two SQLite connections and retains retry ids across force and successful reuse", async () => {
    const f = await fixture();
    const other = new SqliteControlPlaneStore(f.options);
    cleanup.push(() => other.close());
    const [first, second] = await Promise.all([
      f.store.enqueueOrganizationKnowledge({
        agentId: f.leader.agentId,
        scopeId: f.part.id,
        requestId: "request-a",
        now: 100,
      }),
      other.enqueueOrganizationKnowledge({
        agentId: f.secondLeader.agentId,
        scopeId: f.part.id,
        requestId: "request-b",
        force: true,
        now: 100,
      }),
    ]);
    expect(first.currentJob!.id).toBe(second.currentJob!.id);
    const job = await other.claimOrganizationKnowledgeJob({ owner: "second-process", now: 101 });
    await other.finishOrganizationKnowledgeJob({
      jobId: job!.jobId,
      owner: "second-process",
      now: 102,
      analysis: analysis(job!.input!),
    });
    const reused = await f.store.enqueueOrganizationKnowledge({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      requestId: "reused",
      now: 103,
    });
    expect(reused.currentJob!.id).toBe(first.currentJob!.id);
    const retry = await other.enqueueOrganizationKnowledge({
      agentId: f.secondLeader.agentId,
      scopeId: f.part.id,
      requestId: "request-b",
      force: true,
      now: 104,
    });
    expect(retry.currentJob!.id).toBe(first.currentJob!.id);
    const forced = await other.enqueueOrganizationKnowledge({
      agentId: f.secondLeader.agentId,
      scopeId: f.part.id,
      requestId: "explicit-force",
      force: true,
      now: 105,
    });
    expect(forced.currentJob!.id).not.toBe(first.currentJob!.id);
    expect(forced.lastSuccess!.id).toBe(reused.lastSuccess!.id);
    const forcedJob = await other.claimOrganizationKnowledgeJob({
      owner: "second-process",
      now: 106,
    });
    await other.failOrganizationKnowledgeJob({
      jobId: forcedJob!.jobId,
      owner: "second-process",
      now: 107,
      code: "analysis-failed",
    });
    const failed = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!;
    expect(failed.currentJob!.status).toBe("failed");
    expect(failed.lastSuccess!.id).toBe(reused.lastSuccess!.id);
  });

  it("fences expired workers, fails revoked queued work, and never writes from review", async () => {
    const f = await fixture();
    await f.store.enqueueOrganizationKnowledge({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      requestId: "expired",
      now: 100,
    });
    const old = await f.store.claimOrganizationKnowledgeJob({ owner: "old-worker", now: 101 });
    const leaseExpiry = await f.store.nextOrganizationKnowledgeLeaseExpiry();
    expect(leaseExpiry).toBeGreaterThan(101);
    if (leaseExpiry === null) {
      throw new Error("claimed fixture job must have a persisted lease expiry");
    }
    const next = await f.store.enqueueOrganizationKnowledge({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      requestId: "new",
      now: leaseExpiry + 1,
    });
    expect(next.currentJob!.id).not.toBe(old!.jobId);
    await expect(
      f.store.finishOrganizationKnowledgeJob({
        jobId: old!.jobId,
        owner: "old-worker",
        now: leaseExpiry + 2,
        analysis: analysis(old!.input!),
      }),
    ).rejects.toThrow("lease");
    await f.membership(f.leader.userId, "member");
    const revoked = await f.store.claimOrganizationKnowledgeJob({
      owner: "new-worker",
      now: leaseExpiry + 3,
    });
    expect(revoked?.input).toBeNull();
    expect(
      (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.secondLeader.agentId }))
        .selected!.currentJob!.failure!.code,
    ).toBe("authority-revoked");
    await expect(
      f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId, scopeId: f.part.id }),
    ).rejects.toThrow();
  });

  it("pins proposal source versions and withholds derived payloads after retirement or purge", async () => {
    const f = await fixture();
    await generateSuccess(f);
    let snapshot = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!;
    const proposal = snapshot.proposals[0]!;
    const before = await f.store.getOrganizationMemoryLifecycle(f.leader.agentId);
    await Promise.allSettled([
      f.store.decideOrganizationKnowledgeProposal({
        agentId: f.leader.agentId,
        scopeId: f.part.id,
        proposalId: proposal.id,
        expectedRevision: 0,
        decision: "approve",
        reason: "Synthetic review",
        now: 103,
      }),
      f.store.decideOrganizationKnowledgeProposal({
        agentId: f.secondLeader.agentId,
        scopeId: f.part.id,
        proposalId: proposal.id,
        expectedRevision: 0,
        decision: "reject",
        reason: "Concurrent synthetic review",
        now: 103,
      }),
    ]);
    snapshot = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!;
    expect(snapshot.history).toHaveLength(1);
    expect((await f.store.getOrganizationMemoryLifecycle(f.leader.agentId)).claims).toEqual(
      before.claims,
    );
    await f.store.enqueueOrganizationKnowledge({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      requestId: "same-pairs",
      force: true,
      now: 104,
    });
    const job = await f.store.claimOrganizationKnowledgeJob({ owner: "test-worker", now: 105 });
    await f.store.finishOrganizationKnowledgeJob({
      jobId: job!.jobId,
      owner: "test-worker",
      now: 106,
      analysis: analysis(job!.input!),
    });
    expect(
      (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId })).selected!
        .proposals,
    ).toHaveLength(1);
    const db = new DatabaseSync(f.options.databasePath);
    db.prepare("UPDATE organization_memory_claims SET revision = revision + 1 WHERE id = ?").run(
      f.claims[0]!,
    );
    db.close();
    expect(
      (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId })).selected!
        .lastSuccess!.inputStatus,
    ).toBe("stale");
    await f.store.retireOrganizationMemoryClaim({
      agentId: f.leader.agentId,
      claimId: f.claims[0]!,
      reason: "Synthetic retirement",
      retiredAt: 107,
    });
    const retired = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!;
    expect(retired.lastSuccess).toBeNull();
    expect(retired.proposals).toEqual([]);
    expect(retired.history).toEqual([]);
  });
});
