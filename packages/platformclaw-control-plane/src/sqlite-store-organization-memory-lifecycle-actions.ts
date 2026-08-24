import { randomUUID } from "node:crypto";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
  type OrganizationMemoryClaim,
  type OrganizationMemoryLifecycle,
  type OrganizationMemoryPromotionRequest,
} from "./contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import {
  boundedText,
  claimIdentity,
  evidenceItems,
  MAX_REASON_CHARS,
  MAX_TEXT_CHARS,
  personalClaimLookup,
  SqliteControlPlaneOrganizationMemoryLifecycleQueryStore,
  titleForClaim,
} from "./sqlite-store-organization-memory-lifecycle.js";

export abstract class SqliteControlPlaneOrganizationMemoryLifecycleStore
  extends SqliteControlPlaneOrganizationMemoryLifecycleQueryStore
  implements OrganizationMemoryLifecycle
{
  async submitOrganizationMemoryPromotion(
    params: Parameters<OrganizationMemoryLifecycle["submitOrganizationMemoryPromotion"]>[0],
  ): Promise<OrganizationMemoryPromotionRequest> {
    this.ensureOrganizationMemorySchema();
    const actor = this.requireOrganizationMemoryActor(params.agentId);
    const scopes = this.authorizedScopes(params.agentId);
    const requestedSourceClaimId =
      params.sourceKind === "personal"
        ? personalClaimLookup(params.sourceClaimId)
        : claimIdentity(params.sourceClaimId);
    const proposedText = boundedText(params.proposedText, "proposed text", MAX_TEXT_CHARS);
    const reason = boundedText(params.reason, "promotion reason", MAX_REASON_CHARS);
    const evidence = evidenceItems(params.evidence);
    if (
      params.sourceKind !== "personal" &&
      (!Number.isSafeInteger(params.expectedSourceRevision) || params.expectedSourceRevision! < 1)
    ) {
      throw new ControlPlaneStateError("expected source revision must be a positive integer");
    }
    const personalSource =
      params.sourceKind === "personal"
        ? await this.resolvePersonalOrganizationMemorySource?.({
            agentId: params.agentId,
            lookup: requestedSourceClaimId,
          })
        : null;
    if (params.sourceKind === "personal" && !personalSource) {
      throw new ControlPlaneStateError("personal Wiki source page is unavailable or incomplete");
    }
    const sourceClaimId = personalSource?.claimId ?? requestedSourceClaimId;
    const sourceRevision = personalSource?.revision ?? params.expectedSourceRevision!;
    const sourceClaim =
      params.sourceKind === "personal"
        ? null
        : takeFirstSync(
            this.db,
            this.query
              .selectFrom("organization_memory_claims")
              .selectAll()
              .where("id", "=", sourceClaimId),
          );
    if (params.sourceKind !== "personal" && !sourceClaim) {
      throw new ControlPlaneStateError("source claim revision is no longer active");
    }
    const sourceScope =
      params.sourceKind === "personal"
        ? null
        : this.activeScope(params.sourceKind, sourceClaim!.scope_id ?? undefined);
    const targetScope = this.targetScope(params.targetKind, params.targetScopeId);
    this.assertPromotionEdge(params.sourceKind, sourceScope, params.targetKind, targetScope);
    if (params.sourceKind === "personal" && actor.globalRole === "admin") {
      throw new ControlPlaneAuthorizationError(
        "use the explicit administrator direct publication action",
      );
    }
    if (
      params.sourceKind === "personal" &&
      targetScope &&
      actor.globalRole !== "admin" &&
      !this.hasDirectMembership(actor.userId, targetScope.id)
    ) {
      throw new ControlPlaneAuthorizationError(
        "personal knowledge requires direct target membership",
      );
    }
    if (!this.scopeAuthorized(scopes, params.targetKind, targetScope?.id ?? null)) {
      throw new ControlPlaneAuthorizationError("target scope is not available to this employee");
    }
    return runImmediateTransaction(this.db, () => {
      const currentActor = this.requireOrganizationMemoryActor(params.agentId);
      const currentScopes = this.authorizedScopes(params.agentId);
      const currentSourceScope =
        params.sourceKind === "personal"
          ? null
          : this.activeScope(params.sourceKind, sourceClaim!.scope_id ?? undefined);
      const currentTargetScope = this.targetScope(params.targetKind, params.targetScopeId);
      this.assertPromotionEdge(
        params.sourceKind,
        currentSourceScope,
        params.targetKind,
        currentTargetScope,
      );
      if (
        params.sourceKind === "personal" &&
        currentTargetScope &&
        currentActor.globalRole !== "admin" &&
        !this.hasDirectMembership(currentActor.userId, currentTargetScope.id)
      ) {
        throw new ControlPlaneAuthorizationError(
          "personal knowledge requires direct target membership",
        );
      }
      if (
        params.sourceKind === "personal" &&
        params.targetKind === "global" &&
        currentScopes.some((scope) => scope.kind !== "global")
      ) {
        throw new ControlPlaneAuthorizationError(
          "personal knowledge can target Global only when the employee has no active managed scope",
        );
      }
      if (!this.scopeAuthorized(currentScopes, params.targetKind, currentTargetScope?.id ?? null)) {
        throw new ControlPlaneAuthorizationError("target scope is not available to this employee");
      }
      if (params.sourceKind !== "personal") {
        this.requireReadableSource({
          actorScopes: currentScopes,
          sourceKind: params.sourceKind,
          ...(currentSourceScope ? { sourceScopeId: currentSourceScope.id } : {}),
          sourceClaimId,
          sourceRevision,
        });
      }
      const duplicate = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_memory_promotion_requests")
          .leftJoin(
            "organization_memory_promotion_decisions",
            "organization_memory_promotion_decisions.request_id",
            "organization_memory_promotion_requests.id",
          )
          .select("organization_memory_promotion_requests.id")
          .where("source_kind", "=", params.sourceKind)
          .where("source_scope_id", currentSourceScope ? "=" : "is", currentSourceScope?.id ?? null)
          .where("source_claim_id", "=", sourceClaimId)
          .where("source_revision", "=", sourceRevision)
          .where("target_kind", "=", params.targetKind)
          .where("target_scope_id", currentTargetScope ? "=" : "is", currentTargetScope?.id ?? null)
          .where("organization_memory_promotion_decisions.request_id", "is", null),
      );
      if (duplicate) {
        throw new ControlPlaneStateError("an equivalent promotion request is already pending");
      }
      const id = `memory-request-${randomUUID()}`;
      executeSync(
        this.db,
        this.query.insertInto("organization_memory_promotion_requests").values({
          id,
          source_kind: params.sourceKind,
          source_scope_id: currentSourceScope?.id ?? null,
          source_claim_id: sourceClaimId,
          source_revision: sourceRevision,
          target_kind: params.targetKind,
          target_scope_id: currentTargetScope?.id ?? null,
          proposed_text: proposedText,
          evidence_json: JSON.stringify(evidence),
          reason,
          requested_by_user_id: currentActor.userId,
          created_at: params.submittedAt,
        }),
      );
      this.insertAudit(
        currentActor.userId,
        "organization-memory.promotion.requested",
        "memory-promotion",
        id,
        params.submittedAt,
        {
          sourceKind: params.sourceKind,
          targetKind: params.targetKind,
        },
      );
      return this.toRequest(this.requestRow(id)!, currentActor);
    });
  }

  async publishOrganizationMemoryDirect(
    params: Parameters<OrganizationMemoryLifecycle["publishOrganizationMemoryDirect"]>[0],
  ): Promise<OrganizationMemoryPromotionRequest> {
    this.ensureOrganizationMemorySchema();
    const actor = this.requireOrganizationMemoryActor(params.agentId);
    if (actor.globalRole !== "admin") {
      throw new ControlPlaneAuthorizationError("PlatformClaw administrator required");
    }
    const requestedSourceClaimId =
      params.sourceKind === "personal"
        ? personalClaimLookup(params.sourceClaimId)
        : claimIdentity(params.sourceClaimId);
    const proposedText = boundedText(params.proposedText, "proposed text", MAX_TEXT_CHARS);
    const reason = boundedText(params.reason, "direct publication reason", MAX_REASON_CHARS);
    const evidence = evidenceItems(params.evidence);
    if (
      params.sourceKind !== "personal" &&
      (!Number.isSafeInteger(params.expectedSourceRevision) || params.expectedSourceRevision! < 1)
    ) {
      throw new ControlPlaneStateError("expected source revision must be a positive integer");
    }
    const personalSource =
      params.sourceKind === "personal"
        ? await this.resolvePersonalOrganizationMemorySource?.({
            agentId: params.agentId,
            lookup: requestedSourceClaimId,
          })
        : null;
    if (params.sourceKind === "personal" && !personalSource) {
      throw new ControlPlaneStateError("personal Wiki source page is unavailable or incomplete");
    }
    const sourceClaimId = personalSource?.claimId ?? requestedSourceClaimId;
    const sourceRevision = personalSource?.revision ?? params.expectedSourceRevision!;
    return runImmediateTransaction(this.db, () => {
      const currentActor = this.requireOrganizationMemoryActor(params.agentId);
      this.requireAdmin(currentActor.userId);
      const scopes = this.authorizedScopesForUser(currentActor.userId);
      const sourceClaim =
        params.sourceKind === "personal"
          ? null
          : this.requireReadableSource({
              actorScopes: scopes,
              sourceKind: params.sourceKind,
              sourceClaimId,
              sourceRevision,
              sourceScopeId:
                takeFirstSync(
                  this.db,
                  this.query
                    .selectFrom("organization_memory_claims")
                    .select("scope_id")
                    .where("id", "=", sourceClaimId),
                )?.scope_id ?? undefined,
            });
      const sourceScope =
        params.sourceKind === "personal"
          ? null
          : this.activeScope(params.sourceKind, sourceClaim?.scope_id ?? undefined);
      const targetScope = this.targetScope(params.targetKind, params.targetScopeId);
      if (
        sourceScope &&
        !this.resolveOrganizationAuthorizationSnapshot(currentActor.userId, sourceScope.id)
          .canManageMembers
      ) {
        throw new ControlPlaneAuthorizationError("source scope management authority required");
      }
      this.assertDirectPromotionTarget(
        params.sourceKind,
        sourceScope,
        params.targetKind,
        targetScope,
      );
      const requestId = `memory-request-${randomUUID()}`;
      const claimId = `memory-claim-${randomUUID()}`;
      executeSync(
        this.db,
        this.query.insertInto("organization_memory_promotion_requests").values({
          id: requestId,
          source_kind: params.sourceKind,
          source_scope_id: sourceScope?.id ?? null,
          source_claim_id: sourceClaimId,
          source_revision: sourceRevision,
          target_kind: params.targetKind,
          target_scope_id: targetScope?.id ?? null,
          proposed_text: proposedText,
          evidence_json: JSON.stringify(evidence),
          reason,
          requested_by_user_id: currentActor.userId,
          created_at: params.publishedAt,
        }),
      );
      executeSync(
        this.db,
        this.query.insertInto("organization_memory_claims").values({
          id: claimId,
          scope_kind: params.targetKind,
          scope_id: targetScope?.id ?? null,
          title: titleForClaim(proposedText),
          claim_text: proposedText,
          evidence_json: JSON.stringify(evidence),
          source_kind: params.sourceKind,
          source_scope_id: sourceScope?.id ?? null,
          source_claim_id: sourceClaimId,
          source_revision: sourceRevision,
          promotion_request_id: requestId,
          revision: 1,
          status: "active",
          created_by_user_id: currentActor.userId,
          approved_by_user_id: currentActor.userId,
          created_at: params.publishedAt,
          updated_at: params.publishedAt,
          retired_by_user_id: null,
          retired_at: null,
          retirement_reason: null,
        }),
      );
      executeSync(
        this.db,
        this.query.insertInto("organization_memory_promotion_decisions").values({
          id: `memory-decision-${randomUUID()}`,
          request_id: requestId,
          decision: "approved",
          decided_by_user_id: currentActor.userId,
          reason,
          target_claim_id: claimId,
          decided_at: params.publishedAt,
        }),
      );
      this.compileClaimPage(claimId);
      if (params.sourceKind !== "personal") {
        this.compileClaimPage(sourceClaimId);
      }
      this.insertAudit(
        currentActor.userId,
        "organization-memory.promotion.direct-published",
        "memory-promotion",
        requestId,
        params.publishedAt,
        { sourceKind: params.sourceKind, targetKind: params.targetKind, reason },
      );
      return this.toRequest(this.requestRow(requestId)!, currentActor);
    });
  }

  async decideOrganizationMemoryPromotion(
    params: Parameters<OrganizationMemoryLifecycle["decideOrganizationMemoryPromotion"]>[0],
  ): Promise<OrganizationMemoryPromotionRequest> {
    this.ensureOrganizationMemorySchema();
    const actor = this.requireOrganizationMemoryActor(params.agentId);
    const reason = boundedText(params.reason, "decision reason", MAX_REASON_CHARS);
    const initial = this.requestRow(params.requestId);
    if (!initial) {
      throw new ControlPlaneNotFoundError("memory-promotion", params.requestId);
    }
    if (!this.canReviewTarget(actor.userId, actor.globalRole, initial)) {
      throw new ControlPlaneNotFoundError("memory-promotion", params.requestId);
    }
    if (initial.requested_by_user_id === actor.userId) {
      throw new ControlPlaneAuthorizationError("submitters cannot approve their own request");
    }
    if (initial.decision) {
      throw new ControlPlaneStateError("promotion request already has an immutable decision");
    }
    const resolvedPersonalAgentId =
      params.decision === "approve" && initial.source_kind === "personal"
        ? this.activePersonalAgentIdForUser(initial.requested_by_user_id)
        : null;
    const resolvedPersonalSource =
      params.decision === "approve" && initial.source_kind === "personal"
        ? await this.resolvePersonalOrganizationMemorySource?.({
            agentId: resolvedPersonalAgentId!,
            lookup: initial.source_claim_id,
          })
        : null;
    if (
      params.decision === "approve" &&
      initial.source_kind === "personal" &&
      (!resolvedPersonalSource ||
        resolvedPersonalSource.claimId !== initial.source_claim_id ||
        resolvedPersonalSource.revision !== initial.source_revision)
    ) {
      throw new ControlPlaneStateError("personal Wiki source revision is no longer active");
    }
    return runImmediateTransaction(this.db, () => {
      const currentActor = this.requireOrganizationMemoryActor(params.agentId);
      const row = this.requestRow(params.requestId);
      if (!row) {
        throw new ControlPlaneNotFoundError("memory-promotion", params.requestId);
      }
      if (!this.canReviewTarget(currentActor.userId, currentActor.globalRole, row)) {
        throw new ControlPlaneNotFoundError("memory-promotion", params.requestId);
      }
      if (row.requested_by_user_id === currentActor.userId) {
        throw new ControlPlaneAuthorizationError("submitters cannot approve their own request");
      }
      if (row.decision) {
        throw new ControlPlaneStateError("promotion request already has an immutable decision");
      }
      let targetClaimId: string | null = null;
      if (params.decision === "approve") {
        if (
          row.source_kind === "personal" &&
          this.activePersonalAgentIdForUser(row.requested_by_user_id) !== resolvedPersonalAgentId
        ) {
          throw new ControlPlaneStateError("requester personal agent changed during review");
        }
        const scopes = this.authorizedScopesForUser(row.requested_by_user_id);
        if (row.source_kind !== "personal") {
          this.requireReadableSource({
            actorScopes: scopes,
            sourceKind: row.source_kind,
            ...(row.source_scope_id ? { sourceScopeId: row.source_scope_id } : {}),
            sourceClaimId: row.source_claim_id,
            sourceRevision: row.source_revision,
          });
        }
        const target = this.targetScope(row.target_kind, row.target_scope_id ?? undefined);
        if (
          row.source_kind === "personal" &&
          target &&
          !this.hasDirectMembership(row.requested_by_user_id, target.id)
        ) {
          throw new ControlPlaneAuthorizationError(
            "requester no longer has direct target membership",
          );
        }
        if (
          row.source_kind === "personal" &&
          row.target_kind === "global" &&
          scopes.some((scope) => scope.kind !== "global")
        ) {
          throw new ControlPlaneAuthorizationError(
            "requester joined a managed scope after submitting the Global request",
          );
        }
        if (!this.scopeAuthorized(scopes, row.target_kind, target?.id ?? null)) {
          throw new ControlPlaneAuthorizationError(
            "requester is no longer a member of the target scope",
          );
        }
        targetClaimId = `memory-claim-${randomUUID()}`;
        executeSync(
          this.db,
          this.query.insertInto("organization_memory_claims").values({
            id: targetClaimId,
            scope_kind: row.target_kind,
            scope_id: row.target_scope_id,
            title: titleForClaim(row.proposed_text),
            claim_text: row.proposed_text,
            evidence_json: row.evidence_json,
            source_kind: row.source_kind,
            source_scope_id: row.source_scope_id,
            source_claim_id: row.source_claim_id,
            source_revision: row.source_revision,
            promotion_request_id: row.id,
            revision: 1,
            status: "active",
            created_by_user_id: row.requested_by_user_id,
            approved_by_user_id: currentActor.userId,
            created_at: params.decidedAt,
            updated_at: params.decidedAt,
            retired_by_user_id: null,
            retired_at: null,
            retirement_reason: null,
          }),
        );
      }
      const decision = params.decision === "approve" ? "approved" : "rejected";
      executeSync(
        this.db,
        this.query.insertInto("organization_memory_promotion_decisions").values({
          id: `memory-decision-${randomUUID()}`,
          request_id: row.id,
          decision,
          decided_by_user_id: currentActor.userId,
          reason,
          target_claim_id: targetClaimId,
          decided_at: params.decidedAt,
        }),
      );
      if (targetClaimId) {
        this.compileClaimPage(targetClaimId);
        if (row.source_kind !== "personal") {
          this.compileClaimPage(row.source_claim_id);
        }
      }
      this.insertAudit(
        currentActor.userId,
        `organization-memory.promotion.${decision}`,
        "memory-promotion",
        row.id,
        params.decidedAt,
        {
          targetKind: row.target_kind,
          ...(targetClaimId ? { targetClaimId } : {}),
        },
      );
      return this.toRequest(this.requestRow(row.id)!, currentActor);
    });
  }

  async retireOrganizationMemoryClaim(
    params: Parameters<OrganizationMemoryLifecycle["retireOrganizationMemoryClaim"]>[0],
  ): Promise<OrganizationMemoryClaim> {
    this.ensureOrganizationMemorySchema();
    const reason = boundedText(params.reason, "retirement reason", MAX_REASON_CHARS);
    return runImmediateTransaction(this.db, () => {
      const actor = this.requireOrganizationMemoryActor(params.agentId);
      const claim = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_memory_claims")
          .selectAll()
          .where("id", "=", params.claimId),
      );
      if (!claim) {
        throw new ControlPlaneNotFoundError("organization-memory-claim", params.claimId);
      }
      const scope = claim.scope_kind === "global" ? null : this.requireScopeRow(claim.scope_id!);
      if (
        claim.scope_kind === "global"
          ? actor.globalRole !== "admin"
          : !scope ||
            !this.resolveOrganizationAuthorizationSnapshot(actor.userId, scope.id).canManageMembers
      ) {
        throw new ControlPlaneNotFoundError("organization-memory-claim", params.claimId);
      }
      if (claim.status !== "active") {
        throw new ControlPlaneStateError("only an active claim can be retired");
      }
      const pendingPromotion = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_memory_promotion_requests")
          .leftJoin(
            "organization_memory_promotion_decisions",
            "organization_memory_promotion_decisions.request_id",
            "organization_memory_promotion_requests.id",
          )
          .select("organization_memory_promotion_requests.id")
          .where("source_claim_id", "=", claim.id)
          .where("organization_memory_promotion_decisions.request_id", "is", null)
          .limit(1),
      );
      if (pendingPromotion) {
        throw new ControlPlaneStateError(
          "claim retirement requires its pending promotion requests to be decided first",
        );
      }
      executeSync(
        this.db,
        this.query
          .updateTable("organization_memory_claims")
          .set({
            status: "retired",
            revision: claim.revision + 1,
            updated_at: params.retiredAt,
            retired_by_user_id: actor.userId,
            retired_at: params.retiredAt,
            retirement_reason: reason,
          })
          .where("id", "=", claim.id),
      );
      this.compileClaimPage(claim.id);
      if (claim.source_kind !== "personal") {
        this.compileClaimPage(claim.source_claim_id);
      }
      this.insertAudit(
        actor.userId,
        "organization-memory.claim.retired",
        "memory-claim",
        claim.id,
        params.retiredAt,
        { reason },
      );
      const updated = takeFirstSync(
        this.db,
        this.query.selectFrom("organization_memory_claims").selectAll().where("id", "=", claim.id),
      )!;
      return this.toClaim(updated, scope?.name ?? "Global");
    });
  }

  async purgeOrganizationMemoryClaim(
    params: Parameters<OrganizationMemoryLifecycle["purgeOrganizationMemoryClaim"]>[0],
  ): Promise<OrganizationMemoryClaim> {
    this.ensureOrganizationMemorySchema();
    const reason = boundedText(params.reason, "purge reason", MAX_REASON_CHARS);
    return runImmediateTransaction(this.db, () => {
      const actor = this.requireOrganizationMemoryActor(params.agentId);
      this.requireAdmin(actor.userId);
      const claim = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_memory_claims")
          .selectAll()
          .where("id", "=", params.claimId),
      );
      if (!claim) {
        throw new ControlPlaneNotFoundError("organization-memory-claim", params.claimId);
      }
      if (claim.status !== "retired") {
        throw new ControlPlaneStateError("claim must be retired before hard purge");
      }
      executeSync(
        this.db,
        this.query
          .updateTable("organization_memory_claims")
          .set({
            title: "Purged claim",
            claim_text: "",
            evidence_json: "[]",
            status: "purged",
            revision: claim.revision + 1,
            updated_at: params.purgedAt,
            retired_by_user_id: actor.userId,
            retired_at: params.purgedAt,
            retirement_reason: reason,
          })
          .where("id", "=", claim.id),
      );
      // Hard purge erases payload while immutable lineage and decision retain the audit edge.
      executeSync(
        this.db,
        this.query
          .updateTable("organization_memory_promotion_requests")
          .set({
            proposed_text: "[purged]",
            evidence_json: "[]",
            reason: "Purged for privacy or security",
          })
          .where("id", "=", claim.promotion_request_id),
      );
      this.compileClaimPage(claim.id);
      if (claim.source_kind !== "personal") {
        this.compileClaimPage(claim.source_claim_id);
      }
      this.insertAudit(
        actor.userId,
        "organization-memory.claim.purged",
        "memory-claim",
        claim.id,
        params.purgedAt,
        { reason },
      );
      const updated = takeFirstSync(
        this.db,
        this.query.selectFrom("organization_memory_claims").selectAll().where("id", "=", claim.id),
      )!;
      return this.toClaim(
        updated,
        claim.scope_kind === "global" ? "Global" : this.requireScopeRow(claim.scope_id!).name,
      );
    });
  }
}
