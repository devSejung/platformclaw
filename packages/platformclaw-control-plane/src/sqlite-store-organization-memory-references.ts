import { createHash } from "node:crypto";
import { parseMemoryWikiReferenceSpans } from "@openclaw/memory-wiki/reference-api";
import {
  ControlPlaneStateError,
  type OrganizationMemoryReferencesPreview,
  type OrganizationMemoryGraphKind,
  type OrganizationMemoryGraphEdge,
  type PersonalOrganizationMemoryReference,
  type PersonalOrganizationMemorySource,
  type OrganizationMemoryPromotionSourceKind,
} from "./contracts.js";
import { executeSync, takeFirstSync } from "./kysely-sync.js";
import {
  SqliteControlPlaneOrganizationMemoryStore,
  type AuthorizedOrganizationMemoryScope,
} from "./sqlite-store-organization-memory.js";
import type {
  OrganizationMemoryClaimRow,
  OrganizationMemoryPromotionRequestRow,
} from "./sqlite-store-types.js";

const ORGANIZATION_MEMORY_REFERENCE_LIMITS = {
  references: 32,
  relatedCandidates: 64,
  lineageDepth: 4,
} as const;
type ReferenceIdentity = Pick<
  PersonalOrganizationMemoryReference,
  "claimId" | "revision" | "kind" | "scopeId"
>;
type ReferenceInput = {
  references: ReferenceIdentity[];
  textHash: string;
  source: {
    kind: OrganizationMemoryPromotionSourceKind;
    id: string;
    revision: number;
    userId: string;
  };
};
type ReferenceRequest = Pick<
  OrganizationMemoryPromotionRequestRow,
  "id" | "target_kind" | "target_scope_id" | "requested_by_user_id" | "proposed_text"
>;

function organizationMemoryReferenceHash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

/** Promotion owns public reference facts; personal identities never become page links. */
export abstract class SqliteControlPlaneOrganizationMemoryReferenceStore extends SqliteControlPlaneOrganizationMemoryStore {
  protected preparePromotionReferenceInput(params: {
    text: string;
    sourceKind: OrganizationMemoryPromotionSourceKind;
    sourceClaimId: string;
    sourceRevision: number;
    actorUserId: string;
    actorScopes: readonly AuthorizedOrganizationMemoryScope[];
    personalSource: PersonalOrganizationMemorySource | null;
    sourceClaim: OrganizationMemoryClaimRow | null;
  }): { text: string; input: ReferenceInput | null } {
    const { text } = params;
    let spans;
    try {
      spans = parseMemoryWikiReferenceSpans(text);
    } catch {
      throw new ControlPlaneStateError("reference inputs exceed the 32-reference limit");
    }
    const native = params.personalSource;
    if (
      params.sourceKind === "personal" &&
      spans.length &&
      (native?.referencesTextHash !== organizationMemoryReferenceHash(text) ||
        !Array.isArray(native.references) ||
        native.references.length !== spans.length)
    ) {
      throw new ControlPlaneStateError(
        "native Wiki reference resolution is unavailable or changed; reconnect and preview again",
      );
    }
    const references: ReferenceIdentity[] = [];
    let cursor = 0;
    let publicText = "";
    for (const span of spans) {
      let reference: PersonalOrganizationMemoryReference =
        params.sourceKind === "personal"
          ? native!.references!.find(
              (value) => value.start === span.start && value.end === span.end,
            )!
          : { start: span.start, end: span.end };
      if (!reference) {
        throw new ControlPlaneStateError(
          "reference spans changed; preview the submitted text again",
        );
      }
      const organizationPath =
        /^organization\/(global|team|group|part)\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/u.exec(
          span.target,
        );
      const localRows = organizationPath
        ? executeSync(
            this.db,
            this.query
              .selectFrom("organization_memory_claims")
              .selectAll()
              .where("id", "=", organizationPath[2]!),
          ).rows
        : params.sourceClaim
          ? executeSync(
              this.db,
              this.query
                .selectFrom("organization_memory_claims")
                .selectAll()
                .where("scope_kind", "=", params.sourceClaim.scope_kind)
                .where(
                  "scope_id",
                  params.sourceClaim.scope_id === null ? "is" : "=",
                  params.sourceClaim.scope_id,
                )
                .where((eb) => eb.or([eb("id", "=", span.target), eb("title", "=", span.target)]))
                .where("status", "=", "active")
                .orderBy("id")
                .limit(2),
            ).rows
          : [];
      const local = localRows.length === 1 ? localRows[0] : undefined;
      if (
        local &&
        local.status === "active" &&
        (!organizationPath || local.scope_kind === organizationPath[1]) &&
        params.actorScopes.some(
          (scope) => scope.kind === local.scope_kind && (scope.id ?? null) === local.scope_id,
        )
      ) {
        reference = {
          start: span.start,
          end: span.end,
          claimId: local.id,
          revision: local.revision,
          kind: local.scope_kind,
          ...(local.scope_id ? { scopeId: local.scope_id } : {}),
        };
      }
      if (
        !Number.isSafeInteger(reference.start) ||
        !Number.isSafeInteger(reference.end) ||
        reference.start < cursor ||
        reference.end <= reference.start ||
        reference.end > text.length ||
        (reference.claimId !== undefined &&
          (typeof reference.claimId !== "string" ||
            !reference.claimId ||
            reference.claimId.length > 1_000 ||
            !Number.isSafeInteger(reference.revision) ||
            reference.revision! < 1)) ||
        (reference.kind !== undefined &&
          !["personal", "part", "group", "team", "global"].includes(reference.kind))
      ) {
        throw new ControlPlaneStateError("invalid trusted reference input");
      }
      publicText += text.slice(cursor, reference.start) + "(관련 문서 참조)";
      cursor = reference.end;
      references.push(
        reference.claimId
          ? {
              claimId: reference.claimId,
              revision: reference.revision,
              kind: reference.kind ?? "personal",
              ...(reference.scopeId ? { scopeId: reference.scopeId } : {}),
            }
          : {},
      );
    }
    publicText += text.slice(cursor);
    // A selected excerpt shares only its explicit links, never unrelated page relationships.
    if (references.length > ORGANIZATION_MEMORY_REFERENCE_LIMITS.references) {
      throw new ControlPlaneStateError("reference inputs exceed the 32-reference limit");
    }
    return {
      text: publicText,
      input: references.length
        ? {
            references,
            textHash: organizationMemoryReferenceHash(publicText),
            source: {
              kind: params.sourceKind,
              id: params.sourceClaimId,
              revision: params.sourceRevision,
              userId: params.actorUserId,
            },
          }
        : null,
    };
  }

  protected savePromotionReferenceInput(requestId: string, input: ReferenceInput | null): void {
    if (input) {
      executeSync(
        this.db,
        this.query
          .insertInto("organization_memory_promotion_reference_inputs")
          .values({ request_id: requestId, input_json: JSON.stringify(input) }),
      );
    }
  }

  protected promotionReferenceInput(requestId: string): ReferenceInput | null {
    const stored = takeFirstSync(
      this.db,
      this.query
        .selectFrom("organization_memory_promotion_reference_inputs")
        .select("input_json")
        .where("request_id", "=", requestId),
    );
    return stored ? (JSON.parse(stored.input_json) as ReferenceInput) : null;
  }

  protected promotionReferencesPreview(
    request: ReferenceRequest,
    actorUserId: string,
    input = this.promotionReferenceInput(request.id),
  ): OrganizationMemoryReferencesPreview | undefined {
    if (!input) {
      return undefined;
    }
    if (input.textHash !== organizationMemoryReferenceHash(request.proposed_text)) {
      throw new ControlPlaneStateError("reference preview text changed; prepare the source again");
    }
    const scopes = this.authorizedScopesForUser(actorUserId);
    const readable = scopes.some(
      (scope) =>
        scope.kind === request.target_kind && (scope.id ?? null) === request.target_scope_id,
    );
    const resolved: OrganizationMemoryReferencesPreview["resolved"] = [];
    let unresolvedCount = 0,
      blockedCount = 0,
      ambiguousCount = 0;
    const requesterScopes = this.authorizedScopesForUser(request.requested_by_user_id);
    for (const reference of input.references) {
      if (!reference.claimId) {
        unresolvedCount++;
        continue;
      }
      if (!readable) {
        blockedCount++;
        continue;
      }
      const kind = reference.kind ?? "personal";
      if (kind !== "personal") {
        const original = takeFirstSync(
          this.db,
          this.query
            .selectFrom("organization_memory_claims")
            .selectAll()
            .where("id", "=", reference.claimId),
        );
        if (
          !original ||
          original.scope_kind !== kind ||
          !requesterScopes.some(
            (scope) => scope.kind === kind && (scope.id ?? null) === original.scope_id,
          )
        ) {
          blockedCount++;
          continue;
        }
      }
      const matches = this.relatedReferenceCandidates(reference, request).filter((candidate) =>
        this.referenceCorresponds(candidate, reference, request.requested_by_user_id),
      );
      if (matches.length > 1) {
        ambiguousCount++;
        continue;
      }
      const target = matches[0];
      if (!target) {
        unresolvedCount++;
        continue;
      }
      if (!resolved.some((value) => value.id === target.id)) {
        resolved.push({
          id: target.id,
          revision: target.revision,
          title: target.title.slice(0, 500),
          path: `organization/${target.scope_kind}/${target.id}`,
        });
      }
    }
    const ordered = resolved.toSorted((left, right) => left.id.localeCompare(right.id));
    const facts = {
      input,
      destination: [request.target_kind, request.target_scope_id],
      resolved: ordered,
      unresolvedCount,
      blockedCount,
      ambiguousCount,
    };
    return {
      resolved: ordered,
      unresolvedCount,
      blockedCount,
      ambiguousCount,
      fingerprint: organizationMemoryReferenceHash(facts),
    };
  }

  private referenceCorresponds(
    candidate: OrganizationMemoryClaimRow,
    reference: ReferenceIdentity,
    requesterUserId: string,
  ): boolean {
    const kind = reference.kind ?? "personal";
    let current: OrganizationMemoryClaimRow | undefined = candidate;
    for (
      let depth = 0;
      current && depth <= ORGANIZATION_MEMORY_REFERENCE_LIMITS.lineageDepth;
      depth++
    ) {
      if (
        kind !== "personal" &&
        current.id === reference.claimId &&
        current.scope_kind === kind &&
        current.revision === reference.revision
      ) {
        return true;
      }
      const originRequest =
        kind === "personal"
          ? takeFirstSync(
              this.db,
              this.query
                .selectFrom("organization_memory_promotion_requests")
                .select("requested_by_user_id")
                .where("id", "=", current.promotion_request_id),
            )
          : undefined;
      if (
        current.source_kind === kind &&
        current.source_claim_id === reference.claimId &&
        current.source_revision === reference.revision &&
        (kind !== "personal" || originRequest?.requested_by_user_id === requesterUserId)
      ) {
        return true;
      }
      if (current.source_kind === "personal") {
        return false;
      }
      const previous: OrganizationMemoryClaimRow | undefined = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_memory_claims")
          .selectAll()
          .where("id", "=", current.source_claim_id),
      );
      if (
        !previous ||
        previous.scope_kind !== current.source_kind ||
        previous.scope_id !== current.source_scope_id ||
        previous.revision !== current.source_revision
      ) {
        return false;
      }
      current = previous;
    }
    return false;
  }

  private relatedReferenceCandidates(
    reference: ReferenceIdentity,
    request: ReferenceRequest,
  ): OrganizationMemoryClaimRow[] {
    const kind = reference.kind ?? "personal";
    const readableScopes = this.authorizedScopesForUser(request.requested_by_user_id);
    let frontier = executeSync(
      this.db,
      this.query
        .selectFrom("organization_memory_claims as claim")
        .innerJoin(
          "organization_memory_promotion_requests as origin",
          "origin.id",
          "claim.promotion_request_id",
        )
        .selectAll("claim")
        .where((eb) =>
          eb.or([
            eb.and([
              eb.val(kind === "global" ? 0 : 1),
              eb("claim.source_kind", "=", kind === "global" ? "personal" : kind),
              eb("claim.source_claim_id", "=", reference.claimId!),
              eb("claim.source_revision", "=", reference.revision!),
              ...(kind === "personal"
                ? [eb("origin.requested_by_user_id", "=", request.requested_by_user_id)]
                : []),
            ]),
            ...(kind !== "personal"
              ? [
                  eb.and([
                    eb("claim.id", "=", reference.claimId!),
                    eb("claim.scope_kind", "=", kind),
                    eb("claim.revision", "=", reference.revision!),
                  ]),
                ]
              : []),
          ]),
        )
        .where((eb) =>
          eb.or(
            readableScopes.map((scope) =>
              eb.and([
                eb("claim.scope_kind", "=", scope.kind),
                eb("claim.scope_id", scope.id === undefined ? "is" : "=", scope.id ?? null),
              ]),
            ),
          ),
        )
        .where("claim.status", "=", "active")
        .orderBy("claim.id")
        .limit(ORGANIZATION_MEMORY_REFERENCE_LIMITS.relatedCandidates + 1),
    ).rows;
    const seen = new Map<string, OrganizationMemoryClaimRow>();
    for (
      let depth = 0;
      frontier.length && depth <= ORGANIZATION_MEMORY_REFERENCE_LIMITS.lineageDepth;
      depth++
    ) {
      if (frontier.length + seen.size > ORGANIZATION_MEMORY_REFERENCE_LIMITS.relatedCandidates) {
        throw new ControlPlaneStateError(
          "reference lookup exceeds the 64-related-candidate limit; narrow the submitted links",
        );
      }
      for (const candidate of frontier) {
        seen.set(candidate.id, candidate);
      }
      const parents = frontier.filter((parent) => parent.scope_kind !== "global");
      if (!parents.length) {
        break;
      }
      frontier = executeSync(
        this.db,
        this.query
          .selectFrom("organization_memory_claims")
          .selectAll()
          .where("status", "=", "active")
          .where((eb) =>
            eb.or(
              readableScopes.map((scope) =>
                eb.and([
                  eb("scope_kind", "=", scope.kind),
                  eb("scope_id", scope.id === undefined ? "is" : "=", scope.id ?? null),
                ]),
              ),
            ),
          )
          .where((eb) =>
            eb.or(
              parents.map((parent) =>
                eb.and([
                  eb(
                    "source_kind",
                    "=",
                    parent.scope_kind as OrganizationMemoryPromotionSourceKind,
                  ),
                  eb("source_scope_id", parent.scope_id === null ? "is" : "=", parent.scope_id),
                  eb("source_claim_id", "=", parent.id),
                  eb("source_revision", "=", parent.revision),
                ]),
              ),
            ),
          )
          .orderBy("id")
          .limit(ORGANIZATION_MEMORY_REFERENCE_LIMITS.relatedCandidates + 1),
      ).rows.filter((candidate) => !seen.has(candidate.id));
    }
    return [...seen.values()].filter(
      (candidate) =>
        candidate.scope_kind === request.target_kind &&
        candidate.scope_id === request.target_scope_id,
    );
  }

  protected saveApprovedReferences(
    claimId: string,
    revision: number,
    preview: OrganizationMemoryReferencesPreview | undefined,
  ): void {
    for (const target of preview?.resolved ?? []) {
      if (target.id === claimId) {
        continue;
      }
      executeSync(
        this.db,
        this.query
          .insertInto("organization_memory_claim_references")
          .values({
            claim_id: claimId,
            revision,
            target_claim_id: target.id,
            target_revision: target.revision,
          })
          .onConflict((conflict) =>
            conflict.columns(["claim_id", "revision", "target_claim_id"]).doNothing(),
          ),
      );
    }
  }

  protected assertReferenceFreeRevisionText(text: string): void {
    try {
      if (parseMemoryWikiReferenceSpans(text).length) {
        throw new ControlPlaneStateError(
          "new document links require the promotion reference preview; remove them before applying this revision",
        );
      }
    } catch (error) {
      if (error instanceof ControlPlaneStateError) {
        throw error;
      }
      throw new ControlPlaneStateError(
        "document links require a complete promotion reference preview before publication",
      );
    }
  }

  protected referencesForSameScopeRevision(
    survivor: OrganizationMemoryClaimRow,
    rows: readonly OrganizationMemoryClaimRow[],
  ): OrganizationMemoryReferencesPreview | undefined {
    const mergedIds = new Set(rows.map((row) => row.id));
    const targets = new Map<
      string,
      { id: string; revision: number; title: string; path: string }
    >();
    for (const target of this.compiledReferenceLinks(survivor)) {
      if (!mergedIds.has(target.id)) {
        targets.set(target.id, { ...target, title: "관련 문서" });
      }
    }
    if (targets.size > ORGANIZATION_MEMORY_REFERENCE_LIMITS.references) {
      throw new ControlPlaneStateError("merged approved references exceed the 32-reference limit");
    }
    return targets.size
      ? {
          resolved: [...targets.values()],
          unresolvedCount: 0,
          blockedCount: 0,
          ambiguousCount: 0,
          fingerprint: "same-scope-approved-references",
        }
      : undefined;
  }

  protected compiledReferenceLinks(
    claim: OrganizationMemoryClaimRow,
  ): Array<{ id: string; revision: number; path: string }> {
    return executeSync(
      this.db,
      this.query
        .selectFrom("organization_memory_claim_references as reference")
        .innerJoin("organization_memory_claims as target", "target.id", "reference.target_claim_id")
        .select(["target.id", "target.revision", "target.scope_kind"])
        .where("reference.claim_id", "=", claim.id)
        .where("reference.revision", "=", claim.revision)
        .whereRef("target.revision", "=", "reference.target_revision")
        .where("target.status", "=", "active")
        .where("target.scope_kind", "=", claim.scope_kind)
        .where("target.scope_id", claim.scope_id === null ? "is" : "=", claim.scope_id)
        .orderBy("target.id"),
    ).rows.map((target) => ({
      id: target.id,
      revision: target.revision,
      path: `organization/${target.scope_kind}/${target.id}`,
    }));
  }

  protected directlyReferencingClaimIds(targetId: string): string[] {
    return executeSync(
      this.db,
      this.query
        .selectFrom("organization_memory_claim_references as reference")
        .innerJoin("organization_memory_claims as source", "source.id", "reference.claim_id")
        .select("source.id")
        .distinct()
        .where("reference.target_claim_id", "=", targetId)
        .whereRef("reference.revision", "=", "source.revision")
        .where("source.status", "=", "active")
        .orderBy("source.id"),
    ).rows.map((source) => source.id);
  }

  protected override organizationMemoryReferenceGraphEdges(params: {
    kind: OrganizationMemoryGraphKind;
    visibleClaims: ReadonlyMap<string, number>;
  }): OrganizationMemoryGraphEdge[] {
    const ids = [...params.visibleClaims.keys()];
    if (!ids.length) {
      return [];
    }
    return executeSync(
      this.db,
      this.query
        .selectFrom("organization_memory_claim_references as reference")
        .innerJoin("organization_memory_claims as source", "source.id", "reference.claim_id")
        .innerJoin("organization_memory_claims as target", "target.id", "reference.target_claim_id")
        .selectAll("reference")
        .where("source.id", "in", ids)
        .where("target.id", "in", ids)
        .where("source.scope_kind", "=", params.kind)
        .where("target.scope_kind", "=", params.kind)
        .whereRef("source.scope_id", "is", "target.scope_id")
        .where("source.status", "=", "active")
        .where("target.status", "=", "active")
        .whereRef("source.revision", "=", "reference.revision")
        .whereRef("target.revision", "=", "reference.target_revision")
        .orderBy("source.id")
        .orderBy("target.id"),
    )
      .rows.filter(
        (reference) =>
          reference.claim_id !== reference.target_claim_id &&
          params.visibleClaims.get(reference.claim_id) === reference.revision &&
          params.visibleClaims.get(reference.target_claim_id) === reference.target_revision,
      )
      .map((reference) => ({
        source: `organization:${params.kind}:${reference.claim_id}`,
        target: `organization:${params.kind}:${reference.target_claim_id}`,
        type: "reference" as const,
        sourceRevision: reference.revision,
        targetRevision: reference.target_revision,
        inputStatus: "current" as const,
      }));
  }
}
