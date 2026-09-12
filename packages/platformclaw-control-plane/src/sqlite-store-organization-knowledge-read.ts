import { createHash } from "node:crypto";
import { sql } from "kysely";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneStateError,
  type OrganizationMemoryGraph,
  type OrganizationMemoryGraphEdge,
  type OrganizationMemoryGraphKind,
} from "./contracts.js";
import { executeSync, takeFirstSync } from "./kysely-sync.js";
import {
  ORGANIZATION_KNOWLEDGE_POLICY_VERSION,
  ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS,
} from "./organization-knowledge-analysis.js";
import type {
  OrganizationKnowledgeAnalysis,
  OrganizationKnowledgeAnalysisInput,
  OrganizationKnowledgeClaim,
  OrganizationKnowledgeComparison,
  OrganizationKnowledgeJob,
  OrganizationKnowledgeHistoryQuery,
  OrganizationKnowledgeProposal,
  OrganizationKnowledgeReport,
  OrganizationKnowledgeScope,
  OrganizationKnowledgeSnapshot,
} from "./organization-memory-knowledge-contracts.js";
import { ensureOrganizationKnowledgeSchema } from "./sqlite-schema-organization-knowledge.js";
import { SqliteControlPlaneOrganizationJoinStore } from "./sqlite-store-organization-join.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

const MAX_CLAIMS = ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS.claims;
const MAX_TEXT_CHARS = 32_000;
const MAX_RESULT_ROWS = 25;
type JobRow = ControlPlaneDatabase["organization_knowledge_jobs"];
type ReportRow = ControlPlaneDatabase["organization_knowledge_reports"];
type FrozenInput = OrganizationKnowledgeAnalysisInput & {
  versions: Array<{ id: string; revision: number; status: string }>;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function jobView(row: JobRow): OrganizationKnowledgeJob {
  return {
    id: row.id,
    inputFingerprint: row.input_fingerprint,
    status: row.status,
    createdAt: row.created_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.failure_code
      ? {
          failure: {
            code: row.failure_code,
            message: "Analysis did not complete. Request a new report.",
          },
        }
      : {}),
  };
}

export abstract class SqliteControlPlaneOrganizationKnowledgeReadStore extends SqliteControlPlaneOrganizationJoinStore {
  private organizationKnowledgeSchemaReady = false;

  protected ensureKnowledgeSchema(): void {
    if (this.organizationKnowledgeSchemaReady) {
      return;
    }
    this.ensureOrganizationMemorySchema();
    ensureOrganizationKnowledgeSchema(this.db);
    this.organizationKnowledgeSchemaReady = true;
  }

  protected requireKnowledgeScope(
    agentId: string,
    scopeId: string,
    access: "read" | "manage" = "manage",
  ): OrganizationKnowledgeScope {
    const actor = this.requireOrganizationMemoryActor(agentId);
    const scope = this.requireScopeRow(scopeId);
    const membership = takeFirstSync(
      this.db,
      this.query
        .selectFrom("managed_scope_memberships")
        .select("role")
        .where("scope_id", "=", scopeId)
        .where("user_id", "=", actor.userId),
    );
    const authorization = this.resolveOrganizationAuthorizationSnapshot(actor.userId, scopeId);
    const directLeader =
      membership?.role === "leader" && authorization.canRead && authorization.canManageMembers;
    const groupOversight =
      scope.kind === "part" &&
      this.descendantPartKnowledgeScopes(actor.userId).some(
        (candidate) => candidate.id === scope.id,
      );
    // Group oversight is a read entitlement, never a report generation or apply grant.
    // Manage remains the default so existing mutation and job-owner calls stay direct-leader only.
    if (
      (scope.kind !== "part" && scope.kind !== "group") ||
      !(directLeader || (access === "read" && groupOversight)) ||
      this.scopeLineageRows(scope).some((row) => row.status !== "active")
    ) {
      throw new ControlPlaneAuthorizationError(
        "active direct leader required to manage; Group leaders may read their own Part knowledge",
      );
    }
    return {
      id: scope.id,
      kind: scope.kind,
      name: scope.name,
      capabilities: {
        canReadReport: true,
        canGenerateReport: directLeader,
        canReviewProposals: directLeader,
        canApplyProposals: directLeader,
      },
    };
  }

  override async getOrganizationMemoryGraph(params: {
    agentId: string;
    kind: OrganizationMemoryGraphKind;
    scopeId?: string;
  }): Promise<OrganizationMemoryGraph> {
    this.ensureKnowledgeSchema();
    return super.getOrganizationMemoryGraph(params);
  }

  protected override organizationKnowledgeGraphEdges(params: {
    agentId: string;
    kind: OrganizationMemoryGraphKind;
    scopeIds: string[];
    visibleClaims: ReadonlyMap<string, number>;
  }): OrganizationMemoryGraphEdge[] {
    const edges: OrganizationMemoryGraphEdge[] = [];
    if (params.kind !== "part" && params.kind !== "group") {
      return edges;
    }
    for (const scopeId of params.scopeIds) {
      let scope: OrganizationKnowledgeScope;
      try {
        scope = this.requireKnowledgeScope(params.agentId, scopeId, "read");
      } catch (error) {
        if (error instanceof ControlPlaneAuthorizationError) {
          continue;
        }
        throw error;
      }
      const current = this.freezeKnowledgeInput(scope).input;
      const reports = executeSync(
        this.db,
        this.query
          .selectFrom("organization_knowledge_reports")
          .selectAll()
          .where("scope_id", "=", scopeId)
          .orderBy("completed_at", "desc")
          .orderBy("id")
          .limit(MAX_RESULT_ROWS),
      ).rows;
      const report = reports
        .map((row) => this.safeReport(row, current))
        .find((value) => value !== null);
      if (!report) {
        continue;
      }
      for (const comparison of report.comparisons) {
        // Uncertainty does not establish similarity. Changed/retired endpoints cannot
        // carry an old inference; the report retains the visible regeneration warning.
        if (
          comparison.kind === "insufficient-evidence" ||
          comparison.claimRevisions.length !== 2 ||
          !comparison.claimRevisions.every(
            (citation) => params.visibleClaims.get(citation.id) === citation.revision,
          )
        ) {
          continue;
        }
        const [source, target] = comparison.claimIds.toSorted();
        if (!source || !target || source === target) {
          continue;
        }
        const review = takeFirstSync(
          this.db,
          this.query
            .selectFrom("organization_knowledge_proposals as proposal")
            .innerJoin(
              "organization_knowledge_reviews as review",
              "review.proposal_id",
              "proposal.id",
            )
            .select("review.decision")
            .where("proposal.scope_id", "=", scopeId)
            .where(
              "proposal.pair_key",
              "=",
              this.knowledgePairKey(comparison, report.coverage.policyVersion),
            )
            .orderBy("review.revision", "desc")
            .limit(1),
        );
        if (review?.decision === "reject") {
          continue;
        }
        const reviewStatus =
          review?.decision === "approve"
            ? "approved"
            : review?.decision === "keep"
              ? "kept"
              : review?.decision === "apply"
                ? "applied"
                : "pending";
        edges.push({
          source: `organization:${params.kind}:${source}`,
          target: `organization:${params.kind}:${target}`,
          type: "comparison",
          kind: comparison.kind,
          summary: comparison.summary,
          reportId: report.id,
          completedAt: report.completedAt,
          inputStatus: "current",
          reviewStatus,
          claimRevisions: comparison.claimRevisions.map(({ id, revision }) => ({ id, revision })),
        });
      }
    }
    return edges.toSorted(
      (left, right) =>
        left.source.localeCompare(right.source, "en") ||
        left.target.localeCompare(right.target, "en"),
    );
  }

  protected freezeKnowledgeInput(scope: OrganizationKnowledgeScope): {
    input: FrozenInput;
    bounds: OrganizationKnowledgeReport["bounds"];
  } {
    const rows = executeSync(
      this.db,
      this.query
        .selectFrom("organization_memory_claims")
        .select(["id", "revision", "status", "claim_text", "evidence_json"])
        .where("scope_id", "=", scope.id)
        .where("scope_kind", "=", scope.kind)
        .orderBy("id"),
    ).rows;
    const active = rows.filter((row) => row.status === "active");
    const claims: OrganizationKnowledgeClaim[] = [];
    let chars = 0;
    for (const row of active) {
      if (
        claims.length >= MAX_CLAIMS ||
        row.claim_text.length > ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS.claimChars ||
        chars + row.claim_text.length > MAX_TEXT_CHARS
      ) {
        continue;
      }
      const projectedEvidence = this.knowledgeSourceEvidence(row.evidence_json);
      if (
        projectedEvidence.evidenceStatus === "unavailable" ||
        projectedEvidence.evidenceTruncated
      ) {
        continue;
      }
      const evidence = projectedEvidence.evidence!;
      const evidenceChars = evidence.reduce((sum, text) => sum + text.length, 0);
      if (chars + row.claim_text.length + evidenceChars > MAX_TEXT_CHARS) {
        continue;
      }
      chars += row.claim_text.length + evidenceChars;
      claims.push({ id: row.id, revision: row.revision, text: row.claim_text, evidence });
    }
    const versions = rows.map(({ id, revision, status }) => ({ id, revision, status }));
    const inputFingerprint = digest({
      scopeId: scope.id,
      policy: ORGANIZATION_KNOWLEDGE_POLICY_VERSION,
      versions,
    });
    return {
      input: { scopeId: scope.id, inputFingerprint, claims, versions },
      bounds: {
        includedClaims: claims.length,
        totalEligibleClaims: active.length,
        maxClaims: MAX_CLAIMS,
        maxTextChars: MAX_TEXT_CHARS,
        truncated: claims.length !== active.length,
      },
    };
  }

  protected knowledgePairKey(
    comparison: OrganizationKnowledgeComparison,
    policy = ORGANIZATION_KNOWLEDGE_POLICY_VERSION,
  ): string {
    return digest({
      kind: comparison.kind,
      versions: comparison.claimRevisions.toSorted((left, right) =>
        left.id.localeCompare(right.id),
      ),
      policy,
    });
  }

  protected knowledgeSourceEvidence(raw: string): {
    evidence?: string[];
    evidenceStatus: "available" | "unavailable";
    evidenceTruncated?: boolean;
  } {
    let evidence: unknown;
    try {
      evidence = JSON.parse(raw);
    } catch {
      return { evidenceStatus: "unavailable" };
    }
    if (!Array.isArray(evidence) || evidence.some((value) => typeof value !== "string")) {
      return { evidenceStatus: "unavailable" };
    }
    const limits = ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS;
    return {
      evidence: evidence
        .slice(0, limits.evidencePerClaim)
        .map((value: string) => value.slice(0, limits.evidenceChars)),
      evidenceStatus: "available",
      evidenceTruncated:
        evidence.length > limits.evidencePerClaim ||
        evidence.some((value: string) => value.length > limits.evidenceChars),
    };
  }

  protected promotionComparisonSources(
    input: OrganizationKnowledgeAnalysisInput,
    analysis: Pick<OrganizationKnowledgeAnalysis, "comparisons">,
  ) {
    const cited = new Set(analysis.comparisons.flatMap((comparison) => comparison.claimIds));
    return input.claims
      .filter((claim) => cited.has(claim.id))
      .map((claim) =>
        Object.assign(
          {
            id: claim.id,
            revision: claim.revision,
            title: claim.text
              .split(/\r?\n/u)[0]!
              .replace(/^#+\s*/u, "")
              .slice(0, 500),
            text: claim.text,
            textTruncated: false,
          },
          this.knowledgeSourceEvidence(JSON.stringify(claim.evidence)),
        ),
      );
  }

  private safeReport(row: ReportRow, current: FrozenInput): OrganizationKnowledgeReport | null {
    const job = takeFirstSync(
      this.db,
      this.query
        .selectFrom("organization_knowledge_jobs")
        .select("input_json")
        .where("id", "=", row.job_id),
    );
    if (!job) {
      return null;
    }
    const frozen = JSON.parse(job.input_json) as FrozenInput;
    const active = new Set(
      current.versions.filter((value) => value.status === "active").map((value) => value.id),
    );
    // Withhold the whole derived payload after retirement/purge; summaries can
    // disclose erased facts even when their citation links are hidden.
    if (frozen.claims.some((claim) => !active.has(claim.id))) {
      return null;
    }
    return {
      ...(JSON.parse(row.analysis_json) as OrganizationKnowledgeAnalysis),
      id: row.id,
      jobId: row.job_id,
      completedAt: row.completed_at,
      inputFingerprint: row.input_fingerprint,
      inputStatus: row.input_fingerprint === current.inputFingerprint ? "current" : "stale",
      bounds: JSON.parse(row.bounds_json) as OrganizationKnowledgeReport["bounds"],
    };
  }

  protected knowledgeSnapshot(
    agentId: string,
    scopeId: string,
    historyQuery: OrganizationKnowledgeHistoryQuery = {},
  ): OrganizationKnowledgeSnapshot {
    const scope = this.requireKnowledgeScope(agentId, scopeId, "read");
    const { input } = this.freezeKnowledgeInput(scope);
    const reports = executeSync(
      this.db,
      this.query
        .selectFrom("organization_knowledge_reports")
        .selectAll()
        .where("scope_id", "=", scopeId)
        .orderBy("completed_at", "desc")
        .orderBy("id")
        .limit(MAX_RESULT_ROWS + 1),
    ).rows;
    const lastSuccess =
      reports.map((row) => this.safeReport(row, input)).find((value) => value !== null) ?? null;
    const job = takeFirstSync(
      this.db,
      this.query
        .selectFrom("organization_knowledge_jobs")
        .selectAll()
        .where("scope_id", "=", scopeId)
        .orderBy("created_at", "desc")
        .orderBy("id")
        .limit(1),
    );
    const proposalRows = executeSync(
      this.db,
      this.query
        .selectFrom("organization_knowledge_proposals as proposal")
        .innerJoin("organization_knowledge_reports as report", "report.id", "proposal.report_id")
        .innerJoin("organization_knowledge_jobs as source_job", "source_job.id", "report.job_id")
        .leftJoin("organization_knowledge_reviews as latest", "latest.proposal_id", "proposal.id")
        .selectAll("proposal")
        .where("proposal.scope_id", "=", scopeId)
        .where(this.activeKnowledgeHistoryInput(scopeId))
        .where((eb) =>
          eb.or([
            eb("latest.decision", "is", null),
            eb("latest.decision", "in", ["approve", "defer"]),
          ]),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("organization_knowledge_reviews as newer")
                .select("newer.id")
                .whereRef("newer.proposal_id", "=", "proposal.id")
                .whereRef("newer.revision", ">", "latest.revision"),
            ),
          ),
        )
        .orderBy("report.completed_at", "desc")
        .orderBy("proposal.id")
        .limit(MAX_RESULT_ROWS + 1),
    ).rows;
    const proposals: OrganizationKnowledgeProposal[] = [];
    const activeIds = new Set(
      input.versions.filter((value) => value.status === "active").map((value) => value.id),
    );
    for (const row of proposalRows.slice(0, MAX_RESULT_ROWS)) {
      const comparison = JSON.parse(row.comparison_json) as OrganizationKnowledgeComparison;
      if (comparison.claimIds.some((id) => !activeIds.has(id))) {
        continue;
      }
      const review = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_knowledge_reviews")
          .select(["revision", "decision"])
          .where("proposal_id", "=", row.id)
          .orderBy("revision", "desc")
          .limit(1),
      );
      proposals.push({
        ...comparison,
        id: row.id,
        reportId: row.report_id,
        revision: review?.revision ?? 0,
        sourceClaims: comparison.claimRevisions.map((citation) => {
          const source = takeFirstSync(
            this.db,
            this.query
              .selectFrom("organization_memory_claims")
              .select(["id", "revision", "title", "claim_text", "evidence_json"])
              .where("id", "=", citation.id),
          )!;
          return {
            id: source.id,
            revision: source.revision,
            title: source.title,
            text: source.claim_text.slice(0, 8_000),
            textTruncated: source.claim_text.length > 8_000,
            ...this.knowledgeSourceEvidence(source.evidence_json),
          };
        }),
        inputStatus: comparison.claimRevisions.every((citation) =>
          input.versions.some(
            (version) =>
              version.id === citation.id &&
              version.revision === citation.revision &&
              version.status === "active",
          ),
        )
          ? "current"
          : "stale",
        status:
          review?.decision === "apply"
            ? "applied"
            : review?.decision === "approve"
              ? "approved"
              : review?.decision === "reject"
                ? "rejected"
                : review?.decision === "keep"
                  ? "kept"
                  : "pending",
        claimRevisions: JSON.parse(
          row.claim_revisions_json,
        ) as OrganizationKnowledgeProposal["claimRevisions"],
      });
    }
    let historySelect = this.query
      .selectFrom("organization_knowledge_reviews as review")
      .innerJoin(
        "organization_knowledge_proposals as proposal",
        "proposal.id",
        "review.proposal_id",
      )
      .innerJoin("organization_knowledge_reports as report", "report.id", "proposal.report_id")
      .innerJoin("organization_knowledge_jobs as source_job", "source_job.id", "report.job_id")
      .selectAll("review")
      .leftJoin("platform_users as reviewer", "reviewer.id", "review.actor_user_id")
      .select("reviewer.display_name as reviewer_display_name")
      .where("proposal.scope_id", "=", scopeId)
      .where((eb) =>
        eb.or([eb("review.decision", "=", "apply"), this.activeKnowledgeHistoryInput(scopeId)]),
      );
    if (historyQuery.historyDecision !== undefined) {
      if (historyQuery.historyDecision !== "reject") {
        throw new ControlPlaneStateError("historyDecision must be reject");
      }
      historySelect = historySelect.where("review.decision", "=", "reject");
    }
    const cursor = historyQuery.historyCursor;
    if (cursor) {
      if (
        !Number.isSafeInteger(cursor.occurredAt) ||
        cursor.occurredAt < 0 ||
        typeof cursor.id !== "string" ||
        !cursor.id ||
        cursor.id.length > 128 ||
        !takeFirstSync(
          this.db,
          historySelect
            .where("review.id", "=", cursor.id)
            .where("review.occurred_at", "=", cursor.occurredAt),
        )
      ) {
        throw new ControlPlaneStateError("history cursor does not belong to this scope and filter");
      }
      historySelect = historySelect.where((eb) =>
        eb.or([
          eb("review.occurred_at", "<", cursor.occurredAt),
          eb.and([
            eb("review.occurred_at", "=", cursor.occurredAt),
            eb("review.id", ">", cursor.id),
          ]),
        ]),
      );
    }
    const historyRows = executeSync(
      this.db,
      historySelect
        .orderBy("occurred_at", "desc")
        .orderBy("review.id")
        .limit(MAX_RESULT_ROWS + 1),
    ).rows;
    const historyHasMore = historyRows.length > MAX_RESULT_ROWS;
    const lastHistoryRow = historyRows.slice(0, MAX_RESULT_ROWS).at(-1);
    return {
      scope,
      lastSuccess,
      currentJob: job ? jobView(job) : null,
      proposals,
      history: historyRows
        .slice(0, MAX_RESULT_ROWS)
        .filter(
          (row) =>
            row.decision === "apply" ||
            this.historyProposal(row.proposal_id, row.revision, row.decision, input) !== null,
        )
        .map((row) =>
          Object.assign(
            {
              id: row.id,
              proposalId: row.proposal_id,
              revision: row.revision,
              decision: row.decision,
              reason: row.reason,
              occurredAt: row.occurred_at,
              actorUserId: row.actor_user_id,
              ...(row.reviewer_display_name
                ? { actorDisplayName: row.reviewer_display_name.slice(0, 200) }
                : {}),
              proposal:
                this.historyProposal(row.proposal_id, row.revision, row.decision, input) ??
                undefined,
            },
            row.decision === "apply"
              ? {
                  outcome: (() => {
                    const revision = takeFirstSync(
                      this.db,
                      this.query
                        .selectFrom("organization_memory_claim_revisions")
                        .select(["claim_id", "revision"])
                        .where("proposal_id", "=", row.proposal_id)
                        .limit(1),
                    );
                    return revision
                      ? { claimId: revision.claim_id, revision: revision.revision }
                      : undefined;
                  })(),
                }
              : {},
          ),
        ),
      hasMore:
        reports.length > MAX_RESULT_ROWS ||
        proposalRows.length > MAX_RESULT_ROWS ||
        historyRows.length > MAX_RESULT_ROWS,
      historyHasMore,
      ...(historyHasMore && lastHistoryRow
        ? { nextHistoryCursor: { occurredAt: lastHistoryRow.occurred_at, id: lastHistoryRow.id } }
        : {}),
    };
  }

  private historyProposal(
    proposalId: string,
    revision: number,
    decision: ControlPlaneDatabase["organization_knowledge_reviews"]["decision"],
    current: FrozenInput,
  ): OrganizationKnowledgeProposal | null {
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("organization_knowledge_proposals")
        .selectAll()
        .where("id", "=", proposalId),
    );
    if (!row) {
      return null;
    }
    const report = takeFirstSync(
      this.db,
      this.query
        .selectFrom("organization_knowledge_reports")
        .selectAll()
        .where("id", "=", row.report_id),
    );
    if (!report || !this.safeReport(report, current)) {
      return null;
    }
    const job = takeFirstSync(
      this.db,
      this.query
        .selectFrom("organization_knowledge_jobs")
        .select("input_json")
        .where("id", "=", report.job_id),
    );
    if (!job) {
      return null;
    }
    const frozen = JSON.parse(job.input_json) as FrozenInput;
    const comparison = JSON.parse(row.comparison_json) as OrganizationKnowledgeComparison;
    const sourceClaims = this.promotionComparisonSources(frozen, { comparisons: [comparison] });
    if (
      sourceClaims.length !== comparison.claimRevisions.length ||
      !comparison.claimRevisions.every((citation) =>
        sourceClaims.some(
          (source) => source.id === citation.id && source.revision === citation.revision,
        ),
      )
    ) {
      return null;
    }
    return {
      ...comparison,
      id: row.id,
      reportId: row.report_id,
      revision,
      sourceClaims,
      status:
        decision === "apply"
          ? "applied"
          : decision === "approve"
            ? "approved"
            : decision === "reject"
              ? "rejected"
              : decision === "keep"
                ? "kept"
                : "pending",
      inputStatus: comparison.claimRevisions.every((citation) =>
        current.versions.some(
          (version) =>
            version.id === citation.id &&
            version.revision === citation.revision &&
            version.status === "active",
        ),
      )
        ? "current"
        : "stale",
    };
  }

  private activeKnowledgeHistoryInput(scopeId: string) {
    // SQLite's JSON table primitive applies the same whole-input retirement gate
    // before LIMIT. Filtering later can hide reachable history or expose erased-row cursors.
    return sql<boolean>`NOT EXISTS (
      SELECT 1 FROM json_each(${sql.ref("source_job.input_json")}, '$.claims') AS frozen_source
      LEFT JOIN organization_memory_claims AS active_source
        ON active_source.id = json_extract(frozen_source.value, '$.id')
      WHERE active_source.id IS NULL OR active_source.status != 'active'
        OR active_source.scope_id != ${scopeId}
    )`;
  }
}
