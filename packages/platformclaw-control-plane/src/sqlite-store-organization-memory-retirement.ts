import {
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
  type OrganizationMemoryClaim,
  type OrganizationMemoryLifecycle,
} from "./contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { boundedText, MAX_REASON_CHARS } from "./sqlite-store-organization-memory-inputs.js";
import { SqliteControlPlaneOrganizationMemoryRevisionStore } from "./sqlite-store-organization-memory-revisions.js";

/** Retirement and erasure share the canonical compiler's direct inbound invalidation. */
export abstract class SqliteControlPlaneOrganizationMemoryRetirementStore extends SqliteControlPlaneOrganizationMemoryRevisionStore {
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
          .updateTable("organization_memory_claim_revisions")
          .set({ payload_json: "{}", reason: "Purged for privacy or security" })
          .where("claim_id", "=", claim.id),
      );
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
