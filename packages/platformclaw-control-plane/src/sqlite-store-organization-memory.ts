import { sql } from "kysely";
import {
  ControlPlaneAuthorizationError,
  type OrganizationMemoryDocument,
  type OrganizationMemoryVerification,
  type OrganizationMemoryGraph,
  type OrganizationMemoryGraphEdge,
  type OrganizationMemoryGraphKind,
  type OrganizationMemoryReader,
  type OrganizationMemoryScopeKind,
  type OrganizationMemorySearchHit,
} from "./contracts.js";
import { executeSync, runReadTransaction, takeFirstSync } from "./kysely-sync.js";
import { ensureOrganizationMemorySchema } from "./sqlite-schema.js";
import { SqliteControlPlaneSkillHubStore } from "./sqlite-store-skill-hub.js";
import type { OrganizationMemoryPageRow } from "./sqlite-store-types.js";

const MAX_QUERY_CHARS = 1_000;
const MAX_RESULTS = 50;
const MAX_DOCUMENT_CHARS = 64 * 1024;
const MAX_DOCUMENT_LINES = 200;
const ORGANIZATION_MEMORY_PATH =
  /^organization\/(global|team|group|part)\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/u;
const MAX_GRAPH_NODES = 500;
const MAX_GRAPH_EDGES = 2_000;

export type AuthorizedOrganizationMemoryScope = {
  kind: OrganizationMemoryScopeKind;
  id?: string;
  name: string;
  parentScopeId?: string;
};

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized || normalized.length > MAX_QUERY_CHARS) {
    throw new ControlPlaneAuthorizationError(
      `organization memory query must contain 1-${MAX_QUERY_CHARS} characters`,
    );
  }
  return normalized;
}

function scorePage(row: OrganizationMemoryPageRow, query: string): number {
  const needle = query.toLocaleLowerCase("en-US");
  const title = row.title.toLocaleLowerCase("en-US");
  if (title === needle) {
    return 1;
  }
  if (title.includes(needle)) {
    return 0.9;
  }
  return 0.75;
}

function snippet(content: string, query: string): string {
  const lower = content.toLocaleLowerCase("en-US");
  const index = lower.indexOf(query.toLocaleLowerCase("en-US"));
  const start = Math.max(0, index < 0 ? 0 : index - 120);
  const end = Math.min(content.length, start + 480);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`;
}

function likePattern(query: string): string {
  return `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export abstract class SqliteControlPlaneOrganizationMemoryStore
  extends SqliteControlPlaneSkillHubStore
  implements OrganizationMemoryReader
{
  private organizationMemorySchemaReady = false;

  protected ensureOrganizationMemorySchema(): void {
    if (this.organizationMemorySchemaReady) {
      return;
    }
    ensureOrganizationMemorySchema(this.db);
    this.organizationMemorySchemaReady = true;
  }

  protected requireOrganizationMemoryActor(agentId: string): {
    userId: string;
    globalRole: "member" | "admin";
  } {
    const binding = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .innerJoin("platform_users", "platform_users.id", "agent_bindings.user_id")
        .select(["agent_bindings.user_id", "platform_users.status", "platform_users.global_role"])
        .where("agent_bindings.agent_id", "=", agentId)
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active"),
    );
    if (!binding?.user_id || binding.status !== "active") {
      throw new ControlPlaneAuthorizationError("active personal agent required");
    }
    return { userId: binding.user_id, globalRole: binding.global_role };
  }

  protected authorizedScopes(agentId: string): AuthorizedOrganizationMemoryScope[] {
    const actor = this.requireOrganizationMemoryActor(agentId);
    return this.authorizedScopesForUser(actor.userId);
  }

  protected authorizedScopesForUser(userId: string): AuthorizedOrganizationMemoryScope[] {
    const user = this.requireUserRow(userId);
    if (user.status !== "active") {
      throw new ControlPlaneAuthorizationError("active employee required");
    }
    const scopes: AuthorizedOrganizationMemoryScope[] = [
      { kind: "global", name: "Global" },
      ...this.resolveEffectiveOrganizationAccessSnapshot(userId).map(({ scope }) => {
        const result: AuthorizedOrganizationMemoryScope = {
          kind: scope.kind,
          id: scope.id,
          name: scope.name,
        };
        if (scope.parentScopeId) {
          result.parentScopeId = scope.parentScopeId;
        }
        return result;
      }),
      ...this.descendantPartKnowledgeScopes(userId),
    ];
    return [...new Map(scopes.map((scope) => [`${scope.kind}:${scope.id ?? ""}`, scope])).values()];
  }

  protected descendantPartKnowledgeScopes(userId: string): AuthorizedOrganizationMemoryScope[] {
    // The canonical hierarchy is Team -> Group -> Part. Group oversight adds
    // approved-knowledge reads only; generic member-management authority is unchanged.
    return executeSync(
      this.db,
      this.query
        .selectFrom("managed_scopes as part")
        .innerJoin("managed_scopes as parent", "parent.id", "part.parent_scope_id")
        .innerJoin("managed_scopes as team", "team.id", "parent.parent_scope_id")
        .innerJoin("managed_scope_memberships as membership", "membership.scope_id", "parent.id")
        .select(["part.id", "part.name", "part.parent_scope_id"])
        .where("membership.user_id", "=", userId)
        .where("membership.role", "=", "leader")
        .where("part.kind", "=", "part")
        .where("parent.kind", "=", "group")
        .where("team.kind", "=", "team")
        .where("part.status", "=", "active")
        .where("parent.status", "=", "active")
        .where("team.status", "=", "active")
        .where("team.parent_scope_id", "is", null)
        .orderBy("part.id"),
    ).rows.map((scope) => ({
      kind: "part",
      id: scope.id,
      name: scope.name,
      parentScopeId: scope.parent_scope_id!,
    }));
  }

  protected organizationKnowledgeGraphEdges(_params: {
    agentId: string;
    kind: OrganizationMemoryGraphKind;
    scopeIds: string[];
    visibleClaims: ReadonlyMap<string, number>;
  }): OrganizationMemoryGraphEdge[] {
    return [];
  }

  protected organizationMemoryReferenceGraphEdges(_params: {
    kind: OrganizationMemoryGraphKind;
    visibleClaims: ReadonlyMap<string, number>;
  }): OrganizationMemoryGraphEdge[] {
    return [];
  }

  private toHit(
    row: OrganizationMemoryPageRow,
    scope: AuthorizedOrganizationMemoryScope,
    query: string,
  ): OrganizationMemorySearchHit {
    return {
      id: row.id,
      path: `organization/${row.scope_kind}/${row.id}`,
      scopeKind: row.scope_kind,
      ...(row.scope_id ? { scopeId: row.scope_id } : {}),
      scopeName: scope.name,
      title: row.title,
      snippet: snippet(row.content, query),
      score: scorePage(row, query),
      updatedAt: row.updated_at,
    };
  }

  async searchOrganizationMemory(params: {
    agentId: string;
    query: string;
    maxResults?: number;
  }): Promise<OrganizationMemorySearchHit[]> {
    this.ensureOrganizationMemorySchema();
    return runReadTransaction(this.db, () => {
      const query = normalizeQuery(params.query);
      const scopes = this.authorizedScopes(params.agentId);
      const scopeByKey = new Map(scopes.map((scope) => [`${scope.kind}:${scope.id ?? ""}`, scope]));
      const pattern = likePattern(query);
      const rows = executeSync(
        this.db,
        this.query
          .selectFrom("organization_memory_pages")
          .selectAll()
          .where("status", "=", "active")
          .where((eb) =>
            eb.or(
              scopes.map((scope) =>
                scope.kind === "global"
                  ? eb.and([eb("scope_kind", "=", "global"), eb("scope_id", "is", null)])
                  : eb.and([eb("scope_kind", "=", scope.kind), eb("scope_id", "=", scope.id!)]),
              ),
            ),
          )
          .where((eb) =>
            eb.or([
              sql<boolean>`${eb.ref("title")} LIKE ${pattern} ESCAPE '\\'`,
              sql<boolean>`${eb.ref("content")} LIKE ${pattern} ESCAPE '\\'`,
            ]),
          )
          .orderBy(
            sql<number>`CASE WHEN lower(title) = lower(${query}) THEN 0 WHEN title LIKE ${pattern} ESCAPE '\\' THEN 1 ELSE 2 END`,
          )
          .orderBy("updated_at", "desc")
          .orderBy("id")
          .limit(MAX_RESULTS),
      ).rows;
      const limit = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(params.maxResults ?? 10)));
      return rows
        .map((row) =>
          this.toHit(row, scopeByKey.get(`${row.scope_kind}:${row.scope_id ?? ""}`)!, query),
        )
        .toSorted(
          (left, right) =>
            right.score - left.score ||
            right.updatedAt - left.updatedAt ||
            left.path.localeCompare(right.path),
        )
        .slice(0, limit);
    });
  }

  private organizationMemoryVerification(
    ids: string[],
    scopes: AuthorizedOrganizationMemoryScope[],
  ): Map<string, OrganizationMemoryVerification> {
    if (ids.length === 0) {
      return new Map();
    }
    const readable = new Set(scopes.map((scope) => `${scope.kind}:${scope.id ?? ""}`));
    // Claim rows own approval facts; source freshness uses the same read snapshot
    // for documents and graphs and never reads private employee Wiki state.
    const claims = executeSync(
      this.db,
      this.query
        .selectFrom("organization_memory_claims as claim")
        .leftJoin("organization_memory_claims as source", "source.id", "claim.source_claim_id")
        .select([
          "claim.id",
          "claim.revision",
          "claim.source_revision",
          "claim.source_kind",
          "source.scope_kind as source_scope_kind",
          "source.scope_id as source_scope_id",
          "source.revision as current_source_revision",
          "source.status as source_status",
        ])
        .where("claim.id", "in", ids)
        .where("claim.status", "=", "active"),
    ).rows;
    return new Map(
      claims.map((claim) => [
        claim.id,
        {
          approvalStatus: "approved" as const,
          revision: claim.revision,
          sourceRevision: claim.source_revision,
          sourceStatus:
            claim.source_kind !== "personal" &&
            claim.source_status === "active" &&
            readable.has(`${claim.source_scope_kind}:${claim.source_scope_id ?? ""}`)
              ? claim.current_source_revision === claim.source_revision
                ? "current"
                : "changed"
              : "unavailable",
        },
      ]),
    );
  }

  async getOrganizationMemory(params: {
    agentId: string;
    path: string;
    fromLine?: number;
    lineCount?: number;
  }): Promise<OrganizationMemoryDocument | null> {
    this.ensureOrganizationMemorySchema();
    return runReadTransaction(this.db, () => {
      const match = ORGANIZATION_MEMORY_PATH.exec(params.path);
      if (!match) {
        return null;
      }
      const scopes = this.authorizedScopes(params.agentId);
      const row = takeFirstSync(
        this.db,
        this.query
          .selectFrom("organization_memory_pages")
          .selectAll()
          .where("id", "=", match[2]!)
          .where("scope_kind", "=", match[1] as OrganizationMemoryScopeKind)
          .where("status", "=", "active"),
      );
      if (!row) {
        return null;
      }
      const scope = scopes.find(
        (candidate) => candidate.kind === row.scope_kind && (candidate.id ?? null) === row.scope_id,
      );
      if (!scope) {
        return null;
      }
      const lines = row.content.split(/\r?\n/u);
      const fromLine = Math.max(1, Math.trunc(params.fromLine ?? 1));
      const requestedLines = Math.max(
        1,
        Math.min(MAX_DOCUMENT_LINES, Math.trunc(params.lineCount ?? 50)),
      );
      const selected = lines.slice(fromLine - 1, fromLine - 1 + requestedLines);
      const selectedText = selected.join("\n");
      const verification = this.organizationMemoryVerification([row.id], scopes).get(row.id);
      return {
        ...this.toHit(row, scope, row.title),
        content: selectedText.slice(0, MAX_DOCUMENT_CHARS),
        fromLine,
        lineCount: selected.length,
        totalLines: lines.length,
        textTruncated: selectedText.length > MAX_DOCUMENT_CHARS,
        ...(verification ? { verification } : {}),
      };
    });
  }

  async getOrganizationMemoryGraph(params: {
    agentId: string;
    kind: OrganizationMemoryGraphKind;
    scopeId?: string;
  }): Promise<OrganizationMemoryGraph> {
    this.ensureOrganizationMemorySchema();
    return runReadTransaction(this.db, () => {
      const readableScopes = this.authorizedScopes(params.agentId);
      // Select within the current approved-memory read snapshot before any count,
      // cap or relation query; another permitted Part must not affect this graph.
      const scopes = readableScopes.filter(
        (scope) =>
          scope.kind === params.kind &&
          (params.scopeId === undefined || scope.id === params.scopeId),
      );
      if (params.scopeId !== undefined && scopes.length === 0) {
        throw new ControlPlaneAuthorizationError("selected graph scope is unavailable");
      }
      if (scopes.length === 0) {
        return {
          kind: params.kind,
          nodes: [],
          edges: [],
          stats: {
            totalPages: 0,
            totalNodes: 0,
            totalEdges: 0,
            truncated: false,
            partial: false,
          },
        };
      }
      const scopeById = new Map(scopes.map((scope) => [scope.id ?? "", scope]));
      const scopeIds = scopes.flatMap((scope) => (scope.id ? [scope.id] : [])).toSorted();
      const totalPages =
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("organization_memory_pages")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("status", "=", "active")
            .where("scope_kind", "=", params.kind)
            .where((eb) =>
              params.kind === "global"
                ? eb("scope_id", "is", null)
                : eb("scope_id", "in", scopeIds),
            ),
        )?.count ?? 0;
      const rows = executeSync(
        this.db,
        this.query
          .selectFrom("organization_memory_pages")
          .selectAll()
          .where("status", "=", "active")
          .where("scope_kind", "=", params.kind)
          .where((eb) =>
            params.kind === "global" ? eb("scope_id", "is", null) : eb("scope_id", "in", scopeIds),
          )
          .orderBy("scope_id")
          .orderBy("id")
          .limit(MAX_GRAPH_NODES),
      ).rows;
      const verificationById = this.organizationMemoryVerification(
        rows.map((row) => row.id),
        readableScopes,
      );
      const nodes = rows.map((row) => ({
        id: `organization:${params.kind}:${row.id}`,
        path: `organization/${params.kind}/${row.id}`,
        title: row.title,
        scopeName: scopeById.get(row.scope_id ?? "")!.name,
        updatedAt: row.updated_at,
        ...(verificationById.has(row.id) ? { verification: verificationById.get(row.id)! } : {}),
      }));
      const visibleIds = new Set(rows.map((row) => row.id));
      const edgeKeys = new Set<string>();
      let partial = false;
      for (const row of rows) {
        try {
          const provenance = JSON.parse(row.provenance_json) as {
            source?: { kind?: unknown; claimId?: unknown };
            backlinks?: unknown;
          };
          if (
            provenance.source?.kind === params.kind &&
            typeof provenance.source.claimId === "string" &&
            visibleIds.has(provenance.source.claimId)
          ) {
            edgeKeys.add(`${provenance.source.claimId}\0${row.id}`);
          }
          if (Array.isArray(provenance.backlinks)) {
            for (const target of provenance.backlinks) {
              if (typeof target === "string" && visibleIds.has(target)) {
                edgeKeys.add(`${row.id}\0${target}`);
              }
            }
          }
        } catch {
          // A malformed authorized page remains visible, but its relation data is incomplete.
          partial = true;
        }
      }
      const allEdges = [...edgeKeys]
        .map((key) => {
          const [source, target] = key.split("\0");
          return {
            source: `organization:${params.kind}:${source}`,
            target: `organization:${params.kind}:${target}`,
            type: "promotion" as const,
          };
        })
        .toSorted(
          (left, right) =>
            compareText(left.source, right.source) || compareText(left.target, right.target),
        );
      const provenancePairs = new Set(
        allEdges.map((edge) => [edge.source, edge.target].toSorted().join("\0")),
      );
      // Projection runs inside the same authorized read snapshot; it never starts analysis.
      const inferred = this.organizationKnowledgeGraphEdges({
        agentId: params.agentId,
        kind: params.kind,
        scopeIds,
        visibleClaims: new Map(
          [...verificationById].map(([id, verification]) => [id, verification.revision]),
        ),
      }).filter((edge) => !provenancePairs.has([edge.source, edge.target].toSorted().join("\0")));
      const references = this.organizationMemoryReferenceGraphEdges({
        kind: params.kind,
        visibleClaims: new Map(
          [...verificationById].map(([id, verification]) => [id, verification.revision]),
        ),
      });
      const combined: OrganizationMemoryGraphEdge[] = [...allEdges, ...references, ...inferred];
      const edges = combined.slice(0, MAX_GRAPH_EDGES);
      return {
        kind: params.kind,
        ...(params.scopeId === undefined ? {} : { scopeId: params.scopeId }),
        nodes,
        edges,
        stats: {
          totalPages,
          totalNodes: nodes.length,
          totalEdges: edges.length,
          truncated: totalPages > nodes.length || combined.length > edges.length,
          partial,
        },
      };
    });
  }
}
