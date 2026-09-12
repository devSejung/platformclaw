import { createHash } from "node:crypto";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneStateError,
  type OrganizationMemoryPromotionRequest,
} from "./contracts.js";
import { executeSync, takeFirstSync } from "./kysely-sync.js";
import { ORGANIZATION_KNOWLEDGE_POLICY_VERSION } from "./organization-knowledge-analysis.js";
import type {
  OrganizationKnowledgeAnalysis,
  OrganizationKnowledgeAnalysisInput,
  OrganizationPromotionKnowledgeComparison,
} from "./organization-memory-knowledge-contracts.js";
import {
  boundedText,
  MAX_REASON_CHARS,
  MAX_TEXT_CHARS,
  titleForClaim,
} from "./sqlite-store-organization-memory-inputs.js";
import {
  SqliteControlPlaneOrganizationMemoryLifecycleQueryStore,
  type RequestWithDecision,
} from "./sqlite-store-organization-memory-lifecycle.js";

/** Same-scope revisions are distinct from promotion across authority boundaries. */
export abstract class SqliteControlPlaneOrganizationMemoryRevisionStore extends SqliteControlPlaneOrganizationMemoryLifecycleQueryStore {
  protected override toRequest(
    row: RequestWithDecision,
    actor: { userId: string; globalRole: "member" | "admin" },
  ): OrganizationMemoryPromotionRequest {
    const projected = super.toRequest(row, actor);
    if (row.target_kind !== "part" && row.target_kind !== "group") {
      return projected;
    }
    let comparison: OrganizationPromotionKnowledgeComparison = {
      status: "unavailable",
      reason: "Related knowledge has not been compared.",
    };
    if (
      this.scopeAuthorized(
        this.authorizedScopesForUser(actor.userId),
        row.target_kind,
        row.target_scope_id,
      )
    ) {
      const stored = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_memory_promotion_comparisons")
          .selectAll()
          .where("request_id", "=", row.id),
      );
      if (stored) {
        const input = JSON.parse(stored.input_json) as OrganizationKnowledgeAnalysisInput;
        const active = executeSync(
          this.db,
          this.query
            .selectFrom("organization_memory_claims")
            .select("id")
            .where("scope_id", "=", row.target_scope_id)
            .where("status", "=", "active"),
        ).rows;
        if (
          input.claims
            .filter((claim) => claim.id !== row.id)
            .every((claim) => active.some((current) => current.id === claim.id))
        ) {
          comparison = {
            status:
              stored.input_fingerprint === this.promotionKnowledgeFingerprint(row)
                ? "available"
                : "stale",
            analysis: JSON.parse(stored.analysis_json) as OrganizationKnowledgeAnalysis,
            inputFingerprint: stored.input_fingerprint,
            comparedAt: stored.compared_at,
          };
        }
      }
    } else {
      comparison = {
        status: "unavailable",
        reason: "Current target read permission is required for related comparison.",
      };
    }
    return { ...projected, relatedKnowledgeComparison: comparison };
  }
  protected promotionKnowledgeFingerprint(request: {
    target_scope_id: string | null;
    proposed_text: string;
    evidence_json: string;
  }): string {
    const versions = executeSync(
      this.db,
      this.query
        .selectFrom("organization_memory_claims")
        .select(["id", "revision", "status"])
        .where("scope_id", "=", request.target_scope_id)
        .orderBy("id"),
    ).rows;
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const corpus = hash({
      scopeId: request.target_scope_id,
      policy: ORGANIZATION_KNOWLEDGE_POLICY_VERSION,
      versions,
    });
    return hash({
      corpus,
      proposedText: request.proposed_text,
      evidence: JSON.parse(request.evidence_json),
    });
  }
  protected reviseOrganizationMemoryClaimsCommit(params: {
    agentId: string;
    scopeId: string;
    survivorClaimId: string;
    sources: Array<{ id: string; revision: number }>;
    proposedText: string;
    reason: string;
    proposalId: string;
    now: number;
  }): { claimId: string; revision: number } {
    const actor = this.requireOrganizationMemoryActor(params.agentId);
    const scope = this.requireScopeRow(params.scopeId);
    const authorization = this.resolveOrganizationAuthorizationSnapshot(actor.userId, scope.id);
    const membership = takeFirstSync(
      this.db,
      this.query
        .selectFrom("managed_scope_memberships")
        .select("role")
        .where("scope_id", "=", scope.id)
        .where("user_id", "=", actor.userId),
    );
    if (
      (scope.kind !== "part" && scope.kind !== "group") ||
      membership?.role !== "leader" ||
      !authorization.canRead ||
      !authorization.canManageMembers ||
      this.scopeLineageRows(scope).some((entry) => entry.status !== "active")
    ) {
      throw new ControlPlaneAuthorizationError("active direct target leader required for revision");
    }
    const text = boundedText(params.proposedText, "approved revision text", MAX_TEXT_CHARS);
    this.assertReferenceFreeRevisionText(text);
    const reason = boundedText(params.reason, "revision reason", MAX_REASON_CHARS);
    if (
      params.sources.length !== 2 ||
      new Set(params.sources.map((source) => source.id)).size !== 2 ||
      !params.sources.some((source) => source.id === params.survivorClaimId)
    ) {
      throw new ControlPlaneStateError(
        "revision must identify two cited sources and an explicit survivor",
      );
    }
    const rows = params.sources.map((source) => {
      const row = takeFirstSync(
        this.db,
        this.query.selectFrom("organization_memory_claims").selectAll().where("id", "=", source.id),
      );
      if (
        !row ||
        row.scope_id !== scope.id ||
        row.scope_kind !== scope.kind ||
        row.status !== "active" ||
        row.revision !== source.revision
      ) {
        throw new ControlPlaneStateError("revision source changed or is no longer active");
      }
      return row;
    });
    for (const row of rows) {
      const pending = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_memory_promotion_requests as request")
          .leftJoin(
            "organization_memory_promotion_decisions as decision",
            "decision.request_id",
            "request.id",
          )
          .select("request.id")
          .where("request.source_claim_id", "=", row.id)
          .where("decision.request_id", "is", null)
          .limit(1),
      );
      if (pending) {
        throw new ControlPlaneStateError(
          "source has a pending promotion; decide it before revision",
        );
      }
    }
    const survivor = rows.find((row) => row.id === params.survivorClaimId)!;
    const newRevision = survivor.revision + 1;
    const references = this.referencesForSameScopeRevision(survivor, rows);
    const evidence = [...new Set(rows.flatMap((row) => JSON.parse(row.evidence_json) as string[]))];
    for (const row of rows) {
      // Store exact approved bytes before any update. The original promotion
      // remains origin; each later revision owns its own approval fact.
      executeSync(
        this.db,
        this.query
          .insertInto("organization_memory_claim_revisions")
          .values({
            claim_id: row.id,
            revision: row.revision,
            payload_json: JSON.stringify(row),
            approved_by_user_id: row.approved_by_user_id,
            approved_at: row.created_at,
            reason: "Original approved revision",
            proposal_id: null,
          })
          .onConflict((conflict) => conflict.columns(["claim_id", "revision"]).doNothing()),
      );
      executeSync(
        this.db,
        this.query.insertInto("organization_memory_claim_supersedes").values({
          claim_id: survivor.id,
          revision: newRevision,
          source_claim_id: row.id,
          source_revision: row.revision,
        }),
      );
      if (row.id !== survivor.id) {
        executeSync(
          this.db,
          this.query
            .updateTable("organization_memory_claims")
            .set({
              status: "retired",
              revision: row.revision + 1,
              retired_by_user_id: actor.userId,
              retired_at: params.now,
              retirement_reason: reason,
              updated_at: params.now,
            })
            .where("id", "=", row.id),
        );
      }
    }
    executeSync(
      this.db,
      this.query
        .updateTable("organization_memory_claims")
        .set({
          title: titleForClaim(text),
          claim_text: text,
          evidence_json: JSON.stringify(evidence),
          revision: newRevision,
          updated_at: params.now,
        })
        .where("id", "=", survivor.id),
    );
    const updated = takeFirstSync(
      this.db,
      this.query.selectFrom("organization_memory_claims").selectAll().where("id", "=", survivor.id),
    )!;
    executeSync(
      this.db,
      this.query.insertInto("organization_memory_claim_revisions").values({
        claim_id: survivor.id,
        revision: newRevision,
        payload_json: JSON.stringify(updated),
        approved_by_user_id: actor.userId,
        approved_at: params.now,
        reason,
        proposal_id: params.proposalId,
      }),
    );
    this.saveApprovedReferences(survivor.id, newRevision, references);
    for (const row of rows) {
      this.compileClaimPage(row.id);
      if (row.source_kind !== "personal") {
        this.compileClaimPage(row.source_claim_id);
      }
    }
    this.insertAudit(
      actor.userId,
      "organization-memory.claim.revised",
      "memory-claim",
      survivor.id,
      params.now,
      { revision: newRevision, proposalId: params.proposalId, sources: params.sources, reason },
    );
    return { claimId: survivor.id, revision: newRevision };
  }
}
