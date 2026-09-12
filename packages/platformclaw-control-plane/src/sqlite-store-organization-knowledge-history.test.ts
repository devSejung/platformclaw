import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  fixture,
  analysis,
  generateSuccess,
} from "./sqlite-store-organization-knowledge.test-helpers.js";

describe("organization knowledge history", () => {
  it("separates current review from independently filtered paged immutable rejection history", async () => {
    const f = await fixture();
    await generateSuccess(f);
    const initial = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!;
    const proposal = initial.proposals[0]!;
    const db = new DatabaseSync(f.options.databasePath);
    const cloneProposal = db.prepare(
      "INSERT INTO organization_knowledge_proposals SELECT ?,scope_id,report_id,?,comparison_json,claim_revisions_json FROM organization_knowledge_proposals WHERE id=?",
    );
    const insertReview = db.prepare(
      "INSERT INTO organization_knowledge_reviews VALUES(?,?,1,?,?,?,?)",
    );
    for (let index = 0; index < 30; index++) {
      const suffix = String(index).padStart(2, "0");
      cloneProposal.run(`rejected-${suffix}`, `rejected-key-${suffix}`, proposal.id);
      insertReview.run(
        `reject-review-${suffix}`,
        `rejected-${suffix}`,
        "reject",
        f.leader.userId,
        `Rejected synthetic reason ${suffix}`,
        200,
      );
      cloneProposal.run(`kept-${suffix}`, `kept-key-${suffix}`, proposal.id);
      insertReview.run(
        `keep-review-${suffix}`,
        `kept-${suffix}`,
        "keep",
        f.leader.userId,
        "Newer kept synthetic review",
        300,
      );
    }
    db.close();
    const first = (
      await f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.leader.agentId,
        historyDecision: "reject",
      })
    ).selected!;
    expect(first.proposals.map((value) => value.id)).toEqual([proposal.id]);
    expect(first.history).toHaveLength(25);
    expect(first.history.every((value) => value.decision === "reject")).toBe(true);
    expect(first.history[0]!.actorUserId).toBe(f.leader.userId);
    expect(first.history[0]!.proposal!.sourceClaims[0]!.text).toContain("Test condition");
    expect(first.history[0]!.proposal!.sourceClaims[0]!.evidence).toEqual([
      "Synthetic approved example",
    ]);
    expect(first.historyHasMore).toBe(true);
    const next = (
      await f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.ancestor.agentId,
        scopeId: f.part.id,
        historyDecision: "reject",
        historyCursor: first.nextHistoryCursor!,
      })
    ).selected!;
    expect(next.history).toHaveLength(5);
    expect(new Set([...first.history, ...next.history].map((value) => value.id)).size).toBe(30);
    expect(next.nextHistoryCursor).toBeUndefined();
    expect(next.historyHasMore).toBe(false);
    await expect(
      f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.leader.agentId,
        historyDecision: "reject",
        historyCursor: { occurredAt: 300, id: "keep-review-00" },
      }),
    ).rejects.toThrow("cursor");
    const update = new DatabaseSync(f.options.databasePath);
    update
      .prepare(
        "UPDATE organization_memory_claims SET revision=revision+1,claim_text='Current replacement text',evidence_json='[\"New evidence\"]' WHERE id=?",
      )
      .run(f.claims[0]!);
    update.close();
    const historical = (
      await f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.leader.agentId,
        historyDecision: "reject",
      })
    ).selected!;
    expect(historical.history[0]!.proposal!.inputStatus).toBe("stale");
    expect(historical.history[0]!.proposal!.sourceClaims[0]!.text).not.toBe(
      "Current replacement text",
    );
    expect(historical.history[0]!.proposal!.sourceClaims[0]!.evidence).toEqual([
      "Synthetic approved example",
    ]);
  });

  it("excludes retired input before history caps and never exposes hidden audit cursors", async () => {
    const f = await fixture();
    await generateSuccess(f);
    const original = (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId }))
      .selected!.proposals[0]!;
    const db = new DatabaseSync(f.options.databasePath);
    const report = db
      .prepare("SELECT * FROM organization_knowledge_reports WHERE id=?")
      .get(original.reportId) as { job_id: string };
    const frozen = db
      .prepare("SELECT input_json FROM organization_knowledge_jobs WHERE id=?")
      .get(report.job_id) as { input_json: string };
    const input = JSON.parse(frozen.input_json);
    input.claims.push({
      id: "retired-private-source",
      revision: 1,
      text: "Erased private fact",
      evidence: [],
    });
    db.prepare(
      "INSERT INTO organization_knowledge_jobs SELECT 'hidden-job',scope_id,requested_by_user_id,'hidden-request',input_fingerprint,?,bounds_json,status,lease_owner,lease_expires_at,created_at,started_at,completed_at,failure_code FROM organization_knowledge_jobs WHERE id=?",
    ).run(JSON.stringify(input), report.job_id);
    db.prepare(
      "INSERT INTO organization_knowledge_reports SELECT 'hidden-report','hidden-job',scope_id,input_fingerprint,analysis_json,bounds_json,500 FROM organization_knowledge_reports WHERE id=?",
    ).run(original.reportId);
    for (let index = 0; index < 30; index++) {
      db.prepare(
        "INSERT INTO organization_knowledge_proposals SELECT ?,scope_id,'hidden-report',?,comparison_json,claim_revisions_json FROM organization_knowledge_proposals WHERE id=?",
      ).run(`hidden-proposal-${index}`, `hidden-key-${index}`, original.id);
      db.prepare(
        "INSERT INTO organization_knowledge_reviews VALUES(?,?,1,'reject',?,'Erased private rejection reason',500)",
      ).run(`hidden-review-${index}`, `hidden-proposal-${index}`, f.leader.userId);
    }
    db.close();
    await f.store.decideOrganizationKnowledgeProposal({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      proposalId: original.id,
      expectedRevision: 0,
      decision: "reject",
      reason: "Visible rejection",
      now: 200,
    });
    const visible = (
      await f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.leader.agentId,
        historyDecision: "reject",
      })
    ).selected!;
    expect(visible.proposals).toEqual([]);
    expect(visible.history).toHaveLength(1);
    expect(visible.history[0]!.reason).toBe("Visible rejection");
    expect(visible.historyHasMore).toBe(false);
    expect(visible.nextHistoryCursor).toBeUndefined();
    expect(JSON.stringify(visible)).not.toContain("Erased private");
    await expect(
      f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.leader.agentId,
        historyDecision: "reject",
        historyCursor: { occurredAt: 500, id: "hidden-review-0" },
      }),
    ).rejects.toThrow("cursor");
    await f.store.enqueueOrganizationKnowledge({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      requestId: "repeat-rejected",
      force: true,
      now: 600,
    });
    const job = await f.store.claimOrganizationKnowledgeJob({
      owner: "repeat-rejected-worker",
      now: 601,
    });
    await f.store.finishOrganizationKnowledgeJob({
      jobId: job!.jobId,
      owner: "repeat-rejected-worker",
      now: 602,
      analysis: analysis(job!.input!),
    });
    expect(
      (await f.store.getOrganizationKnowledgeSnapshot({ agentId: f.leader.agentId })).selected!
        .proposals,
    ).toEqual([]);
    await f.store.setManagedScopeMembership({
      actorUserId: f.admin.userId,
      scopeId: f.part.id,
      userId: f.leader.userId,
      role: "member",
      reason: "Revoke review read",
      changedAt: 603,
    });
    await expect(
      f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.leader.agentId,
        scopeId: f.part.id,
        historyDecision: "reject",
      }),
    ).rejects.toThrow("leader");
  });
});
