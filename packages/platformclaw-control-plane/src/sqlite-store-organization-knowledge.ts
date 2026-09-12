import { randomUUID } from "node:crypto";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import {
  executeSync,
  runImmediateTransaction,
  runReadTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import {
  ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS,
  validateOrganizationKnowledgeAnalysis,
} from "./organization-knowledge-analysis.js";
import type {
  OrganizationKnowledgeAnalysis,
  OrganizationKnowledgeAnalysisInput,
  OrganizationKnowledgeHistoryQuery,
  OrganizationKnowledgeScope,
  OrganizationKnowledgeSnapshot,
  OrganizationKnowledgeSnapshotResponse,
  OrganizationPromotionKnowledgeComparison,
} from "./organization-memory-knowledge-contracts.js";
import { SqliteControlPlaneOrganizationKnowledgeReadStore } from "./sqlite-store-organization-knowledge-read.js";
import { boundedText, MAX_REASON_CHARS } from "./sqlite-store-organization-memory-inputs.js";

const MAX_SCOPE_RESULTS = 100;
const ORGANIZATION_KNOWLEDGE_LEASE_MS = 5 * 60_000;
type FrozenInput = OrganizationKnowledgeAnalysisInput & {
  versions: Array<{ id: string; revision: number; status: string }>;
};

export abstract class SqliteControlPlaneOrganizationKnowledgeStore extends SqliteControlPlaneOrganizationKnowledgeReadStore {
  async getOrganizationKnowledgeSnapshot(
    params: {
      agentId: string;
      scopeId?: string;
    } & OrganizationKnowledgeHistoryQuery,
  ): Promise<OrganizationKnowledgeSnapshotResponse> {
    this.ensureKnowledgeSchema();
    return runReadTransaction(this.db, () => {
      const actor = this.requireOrganizationMemoryActor(params.agentId);
      const memberships = executeSync(
        this.db,
        this.query
          .selectFrom("managed_scope_memberships as membership")
          .innerJoin("managed_scopes as scope", "scope.id", "membership.scope_id")
          .select("scope.id")
          .where("membership.user_id", "=", actor.userId)
          .where("membership.role", "=", "leader")
          .where("scope.kind", "in", ["part", "group"])
          .where("scope.status", "=", "active")
          .orderBy("scope.id")
          .limit(MAX_SCOPE_RESULTS + 1),
      ).rows;
      const readableIds = [
        ...new Set([
          ...memberships.map((membership) => membership.id),
          ...this.descendantPartKnowledgeScopes(actor.userId).map((scope) => scope.id!),
        ]),
      ].toSorted();
      const scopes: OrganizationKnowledgeScope[] = [];
      for (const scopeId of readableIds.slice(0, MAX_SCOPE_RESULTS)) {
        try {
          scopes.push(this.requireKnowledgeScope(params.agentId, scopeId, "read"));
        } catch (error) {
          if (!(error instanceof ControlPlaneAuthorizationError)) {
            throw error;
          }
        }
      }
      const scopeId = params.scopeId ?? scopes[0]?.id;
      return {
        scopes,
        selected: scopeId ? this.knowledgeSnapshot(params.agentId, scopeId, params) : null,
        scopesHasMore:
          memberships.length > MAX_SCOPE_RESULTS || readableIds.length > MAX_SCOPE_RESULTS,
      };
    });
  }

  async enqueueOrganizationKnowledge(params: {
    agentId: string;
    scopeId: string;
    requestId: string;
    force?: boolean;
    now: number;
  }): Promise<OrganizationKnowledgeSnapshot> {
    this.ensureKnowledgeSchema();
    const requestId = boundedText(params.requestId, "request id", 128);
    return runImmediateTransaction(this.db, () => {
      const scope = this.requireKnowledgeScope(params.agentId, params.scopeId);
      const actor = this.requireOrganizationMemoryActor(params.agentId);
      this.expireKnowledgeLeases(params.now);
      const retry = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_knowledge_requests")
          .select("request_id")
          .where("scope_id", "=", scope.id)
          .where("user_id", "=", actor.userId)
          .where("request_id", "=", requestId),
      );
      if (retry) {
        return this.knowledgeSnapshot(params.agentId, scope.id);
      }
      executeSync(
        this.db,
        this.query
          .insertInto("organization_knowledge_requests")
          .values({ scope_id: scope.id, user_id: actor.userId, request_id: requestId }),
      );
      const active = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_knowledge_jobs")
          .select("id")
          .where("scope_id", "=", scope.id)
          .where("status", "in", ["queued", "running"]),
      );
      if (active) {
        return this.knowledgeSnapshot(params.agentId, scope.id);
      }
      const { input, bounds } = this.freezeKnowledgeInput(scope);
      const reusable = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_knowledge_reports")
          .select("id")
          .where("scope_id", "=", scope.id)
          .where("input_fingerprint", "=", input.inputFingerprint)
          .limit(1),
      );
      if (!params.force && reusable) {
        return this.knowledgeSnapshot(params.agentId, scope.id);
      }
      executeSync(
        this.db,
        this.query.insertInto("organization_knowledge_jobs").values({
          id: `knowledge-job-${randomUUID()}`,
          scope_id: scope.id,
          requested_by_user_id: actor.userId,
          request_id: requestId,
          input_fingerprint: input.inputFingerprint,
          input_json: JSON.stringify(input),
          bounds_json: JSON.stringify(bounds),
          status: "queued",
          lease_owner: null,
          lease_expires_at: params.now + ORGANIZATION_KNOWLEDGE_LEASE_MS,
          created_at: params.now,
          started_at: null,
          completed_at: null,
          failure_code: null,
        }),
      );
      return this.knowledgeSnapshot(params.agentId, scope.id);
    });
  }

  private expireKnowledgeLeases(now: number): void {
    executeSync(
      this.db,
      this.query
        .updateTable("organization_knowledge_jobs")
        .set({
          status: "failed",
          failure_code: "lease-expired",
          completed_at: now,
          lease_owner: null,
          lease_expires_at: null,
        })
        .where("status", "in", ["queued", "running"])
        .where("lease_expires_at", "<=", now),
    );
  }

  async nextOrganizationKnowledgeLeaseExpiry(): Promise<number | null> {
    this.ensureKnowledgeSchema();
    return (
      takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_knowledge_jobs")
          .select("lease_expires_at")
          .where("status", "in", ["queued", "running"])
          .where("lease_expires_at", "is not", null)
          .orderBy("lease_expires_at")
          .limit(1),
      )?.lease_expires_at ?? null
    );
  }

  async claimOrganizationKnowledgeJob(params: {
    owner: string;
    now: number;
  }): Promise<{ jobId: string; input: OrganizationKnowledgeAnalysisInput | null } | null> {
    this.ensureKnowledgeSchema();
    return runImmediateTransaction(this.db, () => {
      this.expireKnowledgeLeases(params.now);
      const row = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_knowledge_jobs")
          .selectAll()
          .where("status", "=", "queued")
          .orderBy("created_at")
          .orderBy("id")
          .limit(1),
      );
      if (!row) {
        return null;
      }
      try {
        const agentId = this.activePersonalAgentIdForUser(row.requested_by_user_id);
        this.requireKnowledgeScope(agentId, row.scope_id);
      } catch (error) {
        if (
          !(error instanceof ControlPlaneAuthorizationError) &&
          !(error instanceof ControlPlaneStateError)
        ) {
          throw error;
        }
        executeSync(
          this.db,
          this.query
            .updateTable("organization_knowledge_jobs")
            .set({
              status: "failed",
              failure_code: "authority-revoked",
              completed_at: params.now,
              lease_owner: null,
              lease_expires_at: null,
            })
            .where("id", "=", row.id),
        );
        return { jobId: row.id, input: null };
      }
      executeSync(
        this.db,
        this.query
          .updateTable("organization_knowledge_jobs")
          .set({
            status: "running",
            lease_owner: params.owner,
            lease_expires_at: params.now + ORGANIZATION_KNOWLEDGE_LEASE_MS,
            started_at: params.now,
          })
          .where("id", "=", row.id),
      );
      const frozen = JSON.parse(row.input_json) as FrozenInput;
      return {
        jobId: row.id,
        input: {
          scopeId: frozen.scopeId,
          inputFingerprint: frozen.inputFingerprint,
          claims: frozen.claims,
        },
      };
    });
  }

  async finishOrganizationKnowledgeJob(params: {
    jobId: string;
    owner: string;
    now: number;
    analysis: OrganizationKnowledgeAnalysis;
  }): Promise<void> {
    this.ensureKnowledgeSchema();
    runImmediateTransaction(this.db, () => {
      const row = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_knowledge_jobs")
          .selectAll()
          .where("id", "=", params.jobId),
      );
      if (
        !row ||
        row.status !== "running" ||
        row.lease_owner !== params.owner ||
        row.lease_expires_at! <= params.now
      ) {
        throw new ControlPlaneStateError("analysis lease is no longer active");
      }
      const agentId = this.activePersonalAgentIdForUser(row.requested_by_user_id);
      const scope = this.requireKnowledgeScope(agentId, row.scope_id);
      const frozen = JSON.parse(row.input_json) as FrozenInput;
      const analysis = validateOrganizationKnowledgeAnalysis(params.analysis, frozen);
      const current = this.freezeKnowledgeInput(scope).input;
      const activeIds = new Set(
        current.versions.filter((value) => value.status === "active").map((value) => value.id),
      );
      if (frozen.claims.some((claim) => !activeIds.has(claim.id))) {
        throw new ControlPlaneStateError("analysis input is no longer active");
      }
      const reportId = `knowledge-report-${randomUUID()}`;
      executeSync(
        this.db,
        this.query.insertInto("organization_knowledge_reports").values({
          id: reportId,
          job_id: row.id,
          scope_id: row.scope_id,
          input_fingerprint: row.input_fingerprint,
          analysis_json: JSON.stringify(analysis),
          bounds_json: row.bounds_json,
          completed_at: params.now,
        }),
      );
      for (const comparison of analysis.comparisons) {
        const claimRevisions = comparison.claimIds
          .map((id) => {
            const claim = frozen.claims.find((value) => value.id === id);
            if (!claim) {
              throw new ControlPlaneStateError("analysis refers to an unknown claim");
            }
            return { id, revision: claim.revision };
          })
          .toSorted((left, right) => left.id.localeCompare(right.id));
        const pairKey = this.knowledgePairKey(comparison);
        executeSync(
          this.db,
          this.query
            .insertInto("organization_knowledge_proposals")
            .values({
              id: `knowledge-proposal-${randomUUID()}`,
              scope_id: row.scope_id,
              report_id: reportId,
              pair_key: pairKey,
              comparison_json: JSON.stringify(comparison),
              claim_revisions_json: JSON.stringify(claimRevisions),
            })
            .onConflict((conflict) => conflict.columns(["scope_id", "pair_key"]).doNothing()),
        );
      }
      executeSync(
        this.db,
        this.query
          .updateTable("organization_knowledge_jobs")
          .set({
            status: "succeeded",
            completed_at: params.now,
            lease_owner: null,
            lease_expires_at: null,
          })
          .where("id", "=", row.id),
      );
    });
  }

  async failOrganizationKnowledgeJob(params: {
    jobId: string;
    owner: string;
    now: number;
    code: string;
  }): Promise<void> {
    this.ensureKnowledgeSchema();
    runImmediateTransaction(this.db, () => {
      executeSync(
        this.db,
        this.query
          .updateTable("organization_knowledge_jobs")
          .set({
            status: "failed",
            completed_at: params.now,
            failure_code: params.code,
            lease_owner: null,
            lease_expires_at: null,
          })
          .where("id", "=", params.jobId)
          .where("status", "=", "running")
          .where("lease_owner", "=", params.owner),
      );
    });
  }

  async decideOrganizationKnowledgeProposal(params: {
    agentId: string;
    scopeId: string;
    proposalId: string;
    expectedRevision: number;
    decision: "approve" | "reject" | "keep";
    reason: string;
    now: number;
  }): Promise<OrganizationKnowledgeSnapshot> {
    this.ensureKnowledgeSchema();
    if (!["approve", "reject", "keep"].includes(params.decision)) {
      throw new ControlPlaneStateError("decision must be approve, reject or keep");
    }
    const reason = boundedText(params.reason, "review reason", MAX_REASON_CHARS);
    return runImmediateTransaction(this.db, () => {
      this.requireKnowledgeScope(params.agentId, params.scopeId);
      const actor = this.requireOrganizationMemoryActor(params.agentId);
      const proposal = this.knowledgeSnapshot(params.agentId, params.scopeId).proposals.find(
        (value) => value.id === params.proposalId,
      );
      if (
        !proposal ||
        proposal.revision !== params.expectedRevision ||
        proposal.status !== "pending"
      ) {
        throw new ControlPlaneStateError("proposal changed or is no longer reviewable");
      }
      for (const version of proposal.claimRevisions) {
        const current = takeFirstSync(
          this.db,
          this.query
            .selectFrom("organization_memory_claims")
            .select(["revision", "status"])
            .where("id", "=", version.id)
            .where("scope_id", "=", params.scopeId),
        );
        if (current?.status !== "active" || current.revision !== version.revision) {
          throw new ControlPlaneStateError(
            "proposal source revision changed; generate a current report",
          );
        }
      }
      executeSync(
        this.db,
        this.query.insertInto("organization_knowledge_reviews").values({
          id: `knowledge-review-${randomUUID()}`,
          proposal_id: proposal.id,
          revision: proposal.revision + 1,
          decision: params.decision,
          actor_user_id: actor.userId,
          reason,
          occurred_at: params.now,
        }),
      );
      return this.knowledgeSnapshot(params.agentId, params.scopeId);
    });
  }

  async applyOrganizationKnowledgeProposal(params: {
    agentId: string;
    scopeId: string;
    proposalId: string;
    expectedRevision: number;
    survivorClaimId: string;
    proposedText: string;
    reason: string;
    now: number;
  }): Promise<OrganizationKnowledgeSnapshot> {
    this.ensureKnowledgeSchema();
    return runImmediateTransaction(this.db, () => {
      this.requireKnowledgeScope(params.agentId, params.scopeId);
      const actor = this.requireOrganizationMemoryActor(params.agentId);
      const proposal = this.knowledgeSnapshot(params.agentId, params.scopeId).proposals.find(
        (value) => value.id === params.proposalId,
      );
      if (
        !proposal ||
        proposal.revision !== params.expectedRevision ||
        proposal.status !== "approved" ||
        proposal.inputStatus !== "current" ||
        (proposal.kind !== "duplicate" && proposal.kind !== "enrichment")
      ) {
        throw new ControlPlaneStateError(
          "only a current approved duplicate or enrichment proposal can be applied",
        );
      }
      this.reviseOrganizationMemoryClaimsCommit({ ...params, sources: proposal.claimRevisions });
      executeSync(
        this.db,
        this.query.insertInto("organization_knowledge_reviews").values({
          id: `knowledge-review-${randomUUID()}`,
          proposal_id: proposal.id,
          revision: proposal.revision + 1,
          decision: "apply",
          actor_user_id: actor.userId,
          reason: boundedText(params.reason, "apply reason", MAX_REASON_CHARS),
          occurred_at: params.now,
        }),
      );
      return this.knowledgeSnapshot(params.agentId, params.scopeId);
    });
  }

  async preparePromotionKnowledgeComparison(params: {
    agentId: string;
    requestId: string;
  }): Promise<{
    input: OrganizationKnowledgeAnalysisInput | null;
    cached: OrganizationPromotionKnowledgeComparison | null;
  }> {
    this.ensureKnowledgeSchema();
    return runReadTransaction(this.db, () => {
      const actor = this.requireOrganizationMemoryActor(params.agentId);
      const request = this.requestRow(params.requestId);
      if (
        !request ||
        (request.requested_by_user_id !== actor.userId &&
          !this.canReviewTarget(actor.userId, actor.globalRole, request))
      ) {
        throw new ControlPlaneAuthorizationError(
          "promotion comparison is not available to this employee",
        );
      }
      if (request.target_kind !== "part" && request.target_kind !== "group") {
        return {
          input: null,
          cached: {
            status: "unavailable",
            reason: "Related comparison is available for Part and Group submissions.",
          },
        };
      }
      const scope = this.activeScope(request.target_kind, request.target_scope_id ?? undefined);
      const readable = this.scopeAuthorized(
        this.authorizedScopes(params.agentId),
        scope.kind,
        scope.id,
      );
      if (!readable) {
        return {
          input: null,
          cached: {
            status: "unavailable",
            reason: "Current target read permission is required for related comparison.",
          },
        };
      }
      const candidateEvidence = JSON.parse(request.evidence_json) as string[];
      if (
        request.proposed_text.length > ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS.claimChars ||
        candidateEvidence.length > ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS.evidencePerClaim ||
        candidateEvidence.some(
          (value) => value.length > ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS.evidenceChars,
        )
      ) {
        return {
          input: null,
          cached: {
            status: "unavailable",
            reason:
              "Submitted content exceeds bounded comparison limits; approval remains available.",
          },
        };
      }
      const frozen = this.freezeKnowledgeInput({
        id: scope.id,
        kind: request.target_kind,
        name: scope.name,
        capabilities: {
          canReadReport: false,
          canGenerateReport: false,
          canReviewProposals: false,
          canApplyProposals: false,
        },
      }).input;
      const input: OrganizationKnowledgeAnalysisInput = {
        scopeId: scope.id,
        inputFingerprint: this.promotionKnowledgeFingerprint(request),
        claims: [
          {
            id: request.id,
            revision: request.source_revision,
            text: request.proposed_text,
            evidence: candidateEvidence,
          },
          ...frozen.claims.slice(0, 8),
        ],
      };
      const previous = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_memory_promotion_comparisons")
          .selectAll()
          .where("request_id", "=", request.id),
      );
      return {
        input,
        cached:
          previous?.input_fingerprint === input.inputFingerprint
            ? {
                status: "available",
                analysis: JSON.parse(previous.analysis_json) as OrganizationKnowledgeAnalysis,
                inputFingerprint: previous.input_fingerprint,
                comparedAt: previous.compared_at,
                sourceClaims: this.promotionComparisonSources(
                  input,
                  JSON.parse(previous.analysis_json) as OrganizationKnowledgeAnalysis,
                ),
              }
            : null,
      };
    });
  }

  async savePromotionKnowledgeComparison(params: {
    agentId: string;
    requestId: string;
    input: OrganizationKnowledgeAnalysisInput;
    analysis: OrganizationKnowledgeAnalysis;
    now: number;
  }): Promise<OrganizationPromotionKnowledgeComparison> {
    const analysis = validateOrganizationKnowledgeAnalysis(params.analysis, params.input);
    const current = await this.preparePromotionKnowledgeComparison(params);
    if (!current.input) {
      return current.cached!;
    }
    return runImmediateTransaction(this.db, () => {
      const actor = this.requireOrganizationMemoryActor(params.agentId);
      const request = this.requestRow(params.requestId);
      if (
        !request ||
        (request.requested_by_user_id !== actor.userId &&
          !this.canReviewTarget(actor.userId, actor.globalRole, request)) ||
        !this.scopeAuthorized(
          this.authorizedScopes(params.agentId),
          request.target_kind,
          request.target_scope_id,
        )
      ) {
        throw new ControlPlaneAuthorizationError("promotion comparison permission changed");
      }
      // Planning preceded this commit. Withhold old derived text after any input
      // change so retirement/purge cannot return erased facts as a stale comparison.
      if (this.promotionKnowledgeFingerprint(request) !== params.input.inputFingerprint) {
        return {
          status: "stale",
          reason: "Comparison inputs changed. Compare again before review.",
        };
      }
      executeSync(
        this.db,
        this.query
          .insertInto("organization_memory_promotion_comparisons")
          .values({
            request_id: params.requestId,
            input_fingerprint: params.input.inputFingerprint,
            input_json: JSON.stringify(params.input),
            analysis_json: JSON.stringify(analysis),
            compared_at: params.now,
          })
          .onConflict((conflict) =>
            conflict.column("request_id").doUpdateSet({
              input_fingerprint: params.input.inputFingerprint,
              input_json: JSON.stringify(params.input),
              analysis_json: JSON.stringify(analysis),
              compared_at: params.now,
            }),
          ),
      );
      return {
        status:
          this.promotionKnowledgeFingerprint(request) === params.input.inputFingerprint
            ? "available"
            : "stale",
        analysis,
        inputFingerprint: params.input.inputFingerprint,
        comparedAt: params.now,
        sourceClaims: this.promotionComparisonSources(params.input, analysis),
      };
    });
  }
}
