import { sql } from "kysely";
import {
  ControlPlaneAuthorizationError,
  type OrganizationMemoryDocument,
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
    return [
      { kind: "global", name: "Global" },
      ...this.resolveEffectiveOrganizationAccessSnapshot(userId).map(({ scope }) => ({
        kind: scope.kind,
        id: scope.id,
        name: scope.name,
        ...(scope.parentScopeId ? { parentScopeId: scope.parentScopeId } : {}),
      })),
    ];
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
      return {
        ...this.toHit(row, scope, row.title),
        content: selected.join("\n").slice(0, MAX_DOCUMENT_CHARS),
        fromLine,
        lineCount: selected.length,
      };
    });
  }
}
