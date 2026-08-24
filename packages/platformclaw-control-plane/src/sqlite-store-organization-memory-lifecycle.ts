import {
  ControlPlaneAuthorizationError,
  ControlPlaneStateError,
  type OrganizationMemoryClaim,
  type OrganizationMemoryLifecycleSnapshot,
  type OrganizationMemoryLifecycleScope,
  type OrganizationMemoryPromotionRequest,
  type OrganizationMemoryPromotionTarget,
  type OrganizationMemoryPromotionSourceKind,
  type OrganizationMemoryScopeKind,
  type ManagedScopeKind,
} from "./contracts.js";
import { executeSync, runReadTransaction, takeFirstSync } from "./kysely-sync.js";
import { prepareOrganizationAuthorizationContext } from "./organization-policy.js";
import { rowToMembership, rowToScope } from "./sqlite-store-core.js";
import {
  SqliteControlPlaneOrganizationMemoryStore,
  type AuthorizedOrganizationMemoryScope,
} from "./sqlite-store-organization-memory.js";
import type {
  ManagedScopeRow,
  OrganizationMemoryClaimRow,
  OrganizationMemoryPromotionDecisionRow,
  OrganizationMemoryPromotionRequestRow,
} from "./sqlite-store-types.js";

export const MAX_TEXT_CHARS = 64 * 1024;
export const MAX_REASON_CHARS = 2_000;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_EVIDENCE_CHARS = 1_000;
const SHARED_CLAIM_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

type RequestWithDecision = OrganizationMemoryPromotionRequestRow & {
  decision: OrganizationMemoryPromotionDecisionRow["decision"] | null;
  decision_reason: string | null;
  decided_at: number | null;
  target_claim_id: string | null;
};

export function boundedText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new ControlPlaneStateError(`${label} must contain 1-${max} characters`);
  }
  return normalized;
}

export function claimIdentity(value: string): string {
  const normalized = value.trim();
  if (!SHARED_CLAIM_ID.test(normalized)) {
    throw new ControlPlaneStateError("source claim id is invalid");
  }
  return normalized;
}

export function personalClaimLookup(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 1_000 ||
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new ControlPlaneStateError("personal Wiki page lookup is invalid");
  }
  return normalized;
}

export function evidenceItems(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_EVIDENCE_ITEMS) {
    throw new ControlPlaneStateError(`evidence is limited to ${MAX_EVIDENCE_ITEMS} items`);
  }
  return values.map((value) => boundedText(value, "evidence item", MAX_EVIDENCE_CHARS));
}

export function titleForClaim(text: string): string {
  const line = text.split(/\r?\n/u).find((entry) => entry.trim()) ?? "Organization memory";
  return (
    line
      .replace(/^#{1,6}\s+/u, "")
      .trim()
      .slice(0, 160) || "Organization memory"
  );
}

function requestStatus(row: RequestWithDecision): "pending" | "approved" | "rejected" {
  return row.decision ?? "pending";
}

export abstract class SqliteControlPlaneOrganizationMemoryLifecycleQueryStore extends SqliteControlPlaneOrganizationMemoryStore {
  protected activeScope(kind: ManagedScopeKind, scopeId: string | undefined): ManagedScopeRow {
    if (!scopeId) {
      throw new ControlPlaneStateError(`${kind} scope id is required`);
    }
    const scope = this.requireScopeRow(scopeId);
    if (
      scope.kind !== kind ||
      this.scopeLineageRows(scope).some((entry) => entry.status !== "active")
    ) {
      throw new ControlPlaneStateError(`active ${kind} scope required`);
    }
    return scope;
  }

  protected targetScope(
    kind: OrganizationMemoryScopeKind,
    scopeId: string | undefined,
  ): ManagedScopeRow | null {
    if (kind === "global") {
      if (scopeId !== undefined) {
        throw new ControlPlaneStateError("global target cannot have a scope id");
      }
      return null;
    }
    return this.activeScope(kind, scopeId);
  }

  protected scopeAuthorized(
    scopes: readonly AuthorizedOrganizationMemoryScope[],
    kind: OrganizationMemoryScopeKind,
    scopeId: string | null,
  ): boolean {
    return scopes.some((scope) => scope.kind === kind && (scope.id ?? null) === (scopeId ?? null));
  }

  protected requireReadableSource(params: {
    actorScopes: readonly AuthorizedOrganizationMemoryScope[];
    sourceKind: OrganizationMemoryPromotionSourceKind;
    sourceScopeId?: string;
    sourceClaimId: string;
    sourceRevision: number;
  }): OrganizationMemoryClaimRow | null {
    if (params.sourceKind === "personal") {
      throw new ControlPlaneStateError("personal source must be resolved by the native Wiki owner");
    }
    const scope = this.activeScope(params.sourceKind, params.sourceScopeId);
    if (!this.scopeAuthorized(params.actorScopes, params.sourceKind, scope.id)) {
      throw new ControlPlaneAuthorizationError("source claim is not readable by this employee");
    }
    const claim = takeFirstSync(
      this.db,
      this.query
        .selectFrom("organization_memory_claims")
        .selectAll()
        .where("id", "=", params.sourceClaimId),
    );
    if (
      !claim ||
      claim.status !== "active" ||
      claim.scope_kind !== params.sourceKind ||
      claim.scope_id !== scope.id ||
      claim.revision !== params.sourceRevision
    ) {
      throw new ControlPlaneStateError("source claim revision is no longer active");
    }
    return claim;
  }

  protected activePersonalAgentIdForUser(userId: string): string {
    const binding = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .select("agent_id")
        .where("kind", "=", "personal")
        .where("user_id", "=", userId)
        .where("state", "=", "active"),
    );
    if (!binding) {
      throw new ControlPlaneStateError("requester no longer has an active personal agent");
    }
    return binding.agent_id;
  }

  protected assertPromotionEdge(
    sourceKind: OrganizationMemoryPromotionSourceKind,
    sourceScope: ManagedScopeRow | null,
    targetKind: OrganizationMemoryScopeKind,
    targetScope: ManagedScopeRow | null,
  ): void {
    if (
      sourceKind === "personal" &&
      ((targetKind === "global" && targetScope === null) || targetScope?.kind === targetKind)
    ) {
      return;
    }
    if (
      sourceKind === "part" &&
      targetKind === "group" &&
      sourceScope?.parent_scope_id === targetScope?.id
    ) {
      return;
    }
    if (
      sourceKind === "group" &&
      targetKind === "team" &&
      sourceScope?.parent_scope_id === targetScope?.id
    ) {
      return;
    }
    if (sourceKind === "team" && targetKind === "global" && targetScope === null) {
      return;
    }
    throw new ControlPlaneStateError(
      "promotion must advance personal to a direct scope, then part to group to team to global",
    );
  }

  protected assertDirectPromotionTarget(
    sourceKind: OrganizationMemoryPromotionSourceKind,
    sourceScope: ManagedScopeRow | null,
    targetKind: OrganizationMemoryScopeKind,
    targetScope: ManagedScopeRow | null,
  ): void {
    if (sourceKind === "personal") {
      return;
    }
    if (targetKind === "global" && targetScope === null) {
      return;
    }
    if (
      targetScope &&
      sourceScope &&
      this.scopeLineageRows(sourceScope).some((scope) => scope.id === targetScope.id)
    ) {
      return;
    }
    throw new ControlPlaneStateError(
      "direct publication target must be an ancestor scope or global",
    );
  }

  protected hasDirectMembership(userId: string, scopeId: string): boolean {
    return Boolean(
      takeFirstSync(
        this.db,
        this.query
          .selectFrom("managed_scope_memberships")
          .select("scope_id")
          .where("user_id", "=", userId)
          .where("scope_id", "=", scopeId),
      ),
    );
  }

  protected canReviewTarget(
    userId: string,
    globalRole: "member" | "admin",
    row: RequestWithDecision,
  ) {
    if (row.target_kind === "global") {
      return globalRole === "admin";
    }
    return this.resolveOrganizationAuthorizationSnapshot(userId, row.target_scope_id!)
      .canManageMembers;
  }

  protected canReview(userId: string, globalRole: "member" | "admin", row: RequestWithDecision) {
    return (
      !row.decision &&
      row.requested_by_user_id !== userId &&
      this.canReviewTarget(userId, globalRole, row)
    );
  }

  protected requestQuery() {
    return this.query
      .selectFrom("organization_memory_promotion_requests")
      .leftJoin(
        "organization_memory_promotion_decisions",
        "organization_memory_promotion_decisions.request_id",
        "organization_memory_promotion_requests.id",
      )
      .selectAll("organization_memory_promotion_requests")
      .select([
        "organization_memory_promotion_decisions.decision",
        "organization_memory_promotion_decisions.reason as decision_reason",
        "organization_memory_promotion_decisions.decided_at",
        "organization_memory_promotion_decisions.target_claim_id",
      ])
      .orderBy("organization_memory_promotion_requests.created_at", "desc");
  }

  protected requestRow(requestId: string): RequestWithDecision | undefined {
    return takeFirstSync(
      this.db,
      this.query
        .selectFrom("organization_memory_promotion_requests")
        .leftJoin(
          "organization_memory_promotion_decisions",
          "organization_memory_promotion_decisions.request_id",
          "organization_memory_promotion_requests.id",
        )
        .selectAll("organization_memory_promotion_requests")
        .select([
          "organization_memory_promotion_decisions.decision",
          "organization_memory_promotion_decisions.reason as decision_reason",
          "organization_memory_promotion_decisions.decided_at",
          "organization_memory_promotion_decisions.target_claim_id",
        ])
        .where("organization_memory_promotion_requests.id", "=", requestId),
    );
  }

  protected toRequest(
    row: RequestWithDecision,
    actor: { userId: string; globalRole: "member" | "admin" },
  ): OrganizationMemoryPromotionRequest {
    const targetScopeName =
      row.target_kind === "global" ? "Global" : this.requireScopeRow(row.target_scope_id!).name;
    return {
      id: row.id,
      sourceKind: row.source_kind,
      ...(row.source_kind !== "personal" || row.requested_by_user_id === actor.userId
        ? { sourceClaimId: row.source_claim_id }
        : {}),
      sourceRevision: row.source_revision,
      targetKind: row.target_kind,
      targetScopeName,
      proposedText: row.proposed_text,
      evidence: JSON.parse(row.evidence_json) as string[],
      reason: row.reason,
      status: requestStatus(row),
      createdAt: row.created_at,
      ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
      ...(row.decision_reason === null ? {} : { decisionReason: row.decision_reason }),
      ...(row.target_claim_id === null ? {} : { targetClaimId: row.target_claim_id }),
      canReview: this.canReview(actor.userId, actor.globalRole, row),
    };
  }

  protected promotionTarget(
    kind: OrganizationMemoryScopeKind,
    scope: ManagedScopeRow | null,
    mode: "request" | "direct",
  ): OrganizationMemoryPromotionTarget {
    return {
      kind,
      scopeName: scope?.name ?? "Global",
      ...(scope ? { scopeId: scope.id } : {}),
      mode,
    };
  }

  protected promotionTargetsForClaim(
    actor: { userId: string; globalRole: "member" | "admin" },
    row: OrganizationMemoryClaimRow,
    readable = true,
  ): OrganizationMemoryPromotionTarget[] {
    if (row.status !== "active" || !readable) {
      return [];
    }
    const sourceScope =
      row.scope_kind === "global"
        ? null
        : this.activeScope(row.scope_kind, row.scope_id ?? undefined);
    if (actor.globalRole === "admin") {
      if (!sourceScope) {
        return [];
      }
      const ancestors = this.scopeLineageRows(sourceScope).slice(1);
      return [
        ...ancestors.map((scope) => this.promotionTarget(scope.kind, scope, "direct")),
        this.promotionTarget("global", null, "direct"),
      ];
    }
    if (row.scope_kind === "part") {
      const parent = this.activeScope("group", sourceScope?.parent_scope_id ?? undefined);
      return [this.promotionTarget("group", parent, "request")];
    }
    if (row.scope_kind === "group") {
      const parent = this.activeScope("team", sourceScope?.parent_scope_id ?? undefined);
      return [this.promotionTarget("team", parent, "request")];
    }
    return row.scope_kind === "team" ? [this.promotionTarget("global", null, "request")] : [];
  }

  protected canAdministerClaim(
    actor: { userId: string; globalRole: "member" | "admin" },
    row: OrganizationMemoryClaimRow,
    managedScopeIds?: ReadonlySet<string>,
  ): boolean {
    return row.scope_kind === "global"
      ? actor.globalRole === "admin"
      : managedScopeIds
        ? managedScopeIds.has(row.scope_id!)
        : this.resolveOrganizationAuthorizationSnapshot(actor.userId, row.scope_id!)
            .canManageMembers;
  }

  protected toClaim(
    row: OrganizationMemoryClaimRow,
    scopeName: string,
    actor?: { userId: string; globalRole: "member" | "admin" },
    managedScopeIds?: ReadonlySet<string>,
    readable = true,
  ): OrganizationMemoryClaim {
    const canAdminister = actor ? this.canAdministerClaim(actor, row, managedScopeIds) : false;
    return {
      id: row.id,
      scopeKind: row.scope_kind,
      scopeName,
      ...(row.scope_id ? { scopeId: row.scope_id } : {}),
      title: row.title,
      text: row.status === "purged" ? "" : row.claim_text,
      revision: row.revision,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.source_kind === "personal" ? {} : { sourceClaimId: row.source_claim_id }),
      ...(actor
        ? {
            promotionTargets: this.promotionTargetsForClaim(actor, row, readable),
            canRetire: row.status === "active" && canAdminister,
            canPurge: row.status === "retired" && actor.globalRole === "admin",
          }
        : {}),
    };
  }

  protected compileClaimPage(claimId: string): void {
    const claim = takeFirstSync(
      this.db,
      this.query.selectFrom("organization_memory_claims").selectAll().where("id", "=", claimId),
    );
    if (!claim || claim.status === "purged") {
      executeSync(
        this.db,
        this.query.deleteFrom("organization_memory_pages").where("id", "=", claimId),
      );
      return;
    }
    const promoted = executeSync(
      this.db,
      this.query
        .selectFrom("organization_memory_claims")
        .select("id")
        .where("source_claim_id", "=", claim.id)
        .where("status", "=", "active")
        .orderBy("id"),
    ).rows.map((entry) => entry.id);
    const relatedClaimIds = [
      ...(claim.source_kind === "personal" ? [] : [claim.source_claim_id]),
      ...promoted,
    ];
    const provenance = JSON.stringify({
      claimId: claim.id,
      promotionRequestId: claim.promotion_request_id,
      source: {
        kind: claim.source_kind,
        claimId: claim.source_claim_id,
        revision: claim.source_revision,
      },
      backlinks: promoted,
      relatedPages: relatedClaimIds,
      report: {
        activeBacklinks: promoted.length,
        activeRelatedPages: relatedClaimIds.length,
      },
    });
    executeSync(
      this.db,
      this.query
        .insertInto("organization_memory_pages")
        .values({
          id: claim.id,
          scope_kind: claim.scope_kind,
          scope_id: claim.scope_id,
          title: claim.title,
          content: claim.claim_text,
          provenance_json: provenance,
          revision: claim.revision,
          status: claim.status === "active" ? "active" : "retired",
          created_at: claim.created_at,
          updated_at: claim.updated_at,
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            title: claim.title,
            content: claim.claim_text,
            provenance_json: provenance,
            revision: claim.revision,
            status: claim.status === "active" ? "active" : "retired",
            updated_at: claim.updated_at,
          }),
        ),
    );
  }

  async getOrganizationMemoryLifecycle(
    agentId: string,
    page: { claims?: number; submitted?: number; reviewable?: number } = {},
  ): Promise<OrganizationMemoryLifecycleSnapshot> {
    this.ensureOrganizationMemorySchema();
    return runReadTransaction(this.db, () => {
      const boundedPage = {
        claims: Math.min(10_000, Math.max(0, page.claims ?? 0)),
        submitted: Math.min(10_000, Math.max(0, page.submitted ?? 0)),
        reviewable: Math.min(10_000, Math.max(0, page.reviewable ?? 0)),
      };
      const actor = this.requireOrganizationMemoryActor(agentId);
      const readScopes = this.authorizedScopes(agentId);
      const allScopeRows = executeSync(
        this.db,
        this.query.selectFrom("managed_scopes").selectAll(),
      ).rows;
      const actorMemberships = executeSync(
        this.db,
        this.query
          .selectFrom("managed_scope_memberships")
          .selectAll()
          .where("user_id", "=", actor.userId),
      ).rows;
      const organizationActor = this.rowToUser(this.requireUserRow(actor.userId));
      const scopesForPolicy = allScopeRows.map(rowToScope);
      const membershipsForPolicy = actorMemberships.map(rowToMembership);
      const organizationAuthorization = prepareOrganizationAuthorizationContext({
        actor: organizationActor,
        scopes: scopesForPolicy,
        memberships: membershipsForPolicy,
      });
      const managedScopeIds = new Set(
        allScopeRows
          .filter(
            (scope) => organizationAuthorization.authorize(rowToScope(scope)).canManageMembers,
          )
          .map((scope) => scope.id),
      );
      const managedScopes = allScopeRows
        .filter((scope) => managedScopeIds.has(scope.id))
        .map((scope) => ({
          kind: scope.kind,
          id: scope.id,
          name: scope.name,
          ...(scope.parent_scope_id ? { parentScopeId: scope.parent_scope_id } : {}),
        }));
      const scopes = [
        ...new Map(
          [...readScopes, ...managedScopes].map((scope) => [
            `${scope.kind}:${scope.id ?? ""}`,
            scope,
          ]),
        ).values(),
      ];
      const readScopeKeys = new Set(readScopes.map((scope) => `${scope.kind}:${scope.id ?? ""}`));
      const claimLimit = 25;
      const requestLimit = 25;
      const archivedScopeIds =
        actor.globalRole === "admin"
          ? executeSync(
              this.db,
              this.query.selectFrom("managed_scopes").select("id").where("status", "=", "archived"),
            ).rows.map((row) => row.id)
          : [];
      const claimRows = executeSync(
        this.db,
        this.query
          .selectFrom("organization_memory_claims")
          .selectAll()
          .where("status", "!=", "purged")
          .where((eb) =>
            eb.or([
              ...scopes.map((scope) =>
                scope.kind === "global"
                  ? eb.and([eb("scope_kind", "=", "global"), eb("scope_id", "is", null)])
                  : eb.and([eb("scope_kind", "=", scope.kind), eb("scope_id", "=", scope.id!)]),
              ),
              ...(archivedScopeIds.length > 0
                ? [eb.and([eb("status", "=", "retired"), eb("scope_id", "in", archivedScopeIds)])]
                : []),
            ]),
          )
          .orderBy("updated_at", "desc")
          .offset(boundedPage.claims)
          .limit(claimLimit + 1),
      ).rows;
      const submittedRows = executeSync(
        this.db,
        this.requestQuery()
          .where("requested_by_user_id", "=", actor.userId)
          .offset(boundedPage.submitted)
          .limit(requestLimit + 1),
      ).rows;
      const administeredTargets = scopes.filter((scope) =>
        scope.kind === "global" ? actor.globalRole === "admin" : managedScopeIds.has(scope.id!),
      );
      const reviewableRows =
        administeredTargets.length === 0
          ? []
          : executeSync(
              this.db,
              this.requestQuery()
                .where("organization_memory_promotion_decisions.request_id", "is", null)
                .where("requested_by_user_id", "!=", actor.userId)
                .where((eb) =>
                  eb.or(
                    administeredTargets.map((scope) =>
                      scope.kind === "global"
                        ? eb.and([
                            eb("target_kind", "=", "global"),
                            eb("target_scope_id", "is", null),
                          ])
                        : eb.and([
                            eb("target_kind", "=", scope.kind),
                            eb("target_scope_id", "=", scope.id!),
                          ]),
                    ),
                  ),
                )
                .offset(boundedPage.reviewable)
                .limit(requestLimit + 1),
            ).rows;
      const claims = claimRows
        .slice(0, claimLimit)
        .map((row) =>
          this.toClaim(
            row,
            row.scope_kind === "global" ? "Global" : this.requireScopeRow(row.scope_id!).name,
            actor,
            managedScopeIds,
            readScopeKeys.has(`${row.scope_kind}:${row.scope_id ?? ""}`),
          ),
        );
      const directMembershipIds = new Set(actorMemberships.map((row) => row.scope_id));
      const personalTargets: OrganizationMemoryPromotionTarget[] =
        actor.globalRole === "admin"
          ? [
              ...scopes
                .filter((scope) => scope.kind !== "global")
                .map((scope) =>
                  this.promotionTarget(scope.kind, this.requireScopeRow(scope.id!), "direct"),
                ),
              this.promotionTarget("global", null, "direct"),
            ]
          : scopes
              .filter((scope) => scope.id && directMembershipIds.has(scope.id))
              .map((scope) =>
                this.promotionTarget(scope.kind, this.requireScopeRow(scope.id!), "request"),
              );
      if (actor.globalRole !== "admin" && personalTargets.length === 0) {
        personalTargets.push(this.promotionTarget("global", null, "request"));
      }
      return {
        scopes: scopes.map((scope) => {
          const projected: OrganizationMemoryLifecycleScope = {
            kind: scope.kind,
            name: scope.name,
            canAdminister:
              scope.kind === "global"
                ? actor.globalRole === "admin"
                : managedScopeIds.has(scope.id!),
          };
          if (scope.id) {
            projected.id = scope.id;
          }
          if (scope.parentScopeId) {
            projected.parentScopeId = scope.parentScopeId;
          }
          return projected;
        }),
        personalTargets,
        claims,
        submitted: submittedRows.slice(0, requestLimit).map((row) => this.toRequest(row, actor)),
        reviewable: reviewableRows.slice(0, requestLimit).map((row) => this.toRequest(row, actor)),
        canApproveGlobal: actor.globalRole === "admin",
        ...(claimRows.length > claimLimit ||
        submittedRows.length > requestLimit ||
        reviewableRows.length > requestLimit
          ? {
              next: {
                ...(claimRows.length > claimLimit
                  ? { claims: boundedPage.claims + claimLimit }
                  : {}),
                ...(submittedRows.length > requestLimit
                  ? { submitted: boundedPage.submitted + requestLimit }
                  : {}),
                ...(reviewableRows.length > requestLimit
                  ? { reviewable: boundedPage.reviewable + requestLimit }
                  : {}),
              },
            }
          : {}),
      };
    });
  }
}
