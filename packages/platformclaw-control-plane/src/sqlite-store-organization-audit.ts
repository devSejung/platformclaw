import { sql } from "kysely";
import type {
  ManagedScope,
  OrganizationAuditCursor,
  OrganizationAuditPage,
  OrganizationAuditRecord,
  OrganizationUserSummary,
} from "./contracts.js";
import { executeSync, runReadTransaction } from "./kysely-sync.js";
import { SqliteControlPlaneOrganizationMemoryLifecycleStore } from "./sqlite-store-organization-memory-lifecycle-actions.js";

function auditCategory(action: string): OrganizationAuditRecord["category"] {
  if (/^scope\.(create|rename|archive)/u.test(action)) {
    return "scope";
  }
  if (action.startsWith("scope.membership.")) {
    return "membership";
  }
  if (action.startsWith("scope.primary.")) {
    return "primary";
  }
  if (action.startsWith("organization.join.")) {
    return "join";
  }
  return "other";
}

function normalizedAction(action: string): string {
  if (action.startsWith("scope.create")) {
    return "scope.created";
  }
  if (action.startsWith("scope.rename")) {
    return "scope.renamed";
  }
  if (action.startsWith("scope.archive")) {
    return "scope.archived";
  }
  if (action.startsWith("scope.membership.remove")) {
    return "scope.membership.removed";
  }
  if (action.startsWith("scope.membership.set")) {
    return "scope.membership.set";
  }
  if (action === "scope.primary.cleared") {
    return action;
  }
  if (action.startsWith("scope.primary.change")) {
    return "scope.primary.changed";
  }
  if (action.startsWith("organization.join.request")) {
    return "organization.join.requested";
  }
  if (action.startsWith("organization.join.cancel")) {
    return "organization.join.cancelled";
  }
  if (action.startsWith("organization.join.approved")) {
    return "organization.join.approved";
  }
  if (action.startsWith("organization.join.rejected")) {
    return "organization.join.rejected";
  }
  return "organization.other";
}

function publicUser(user: OrganizationUserSummary): Omit<OrganizationUserSummary, "id"> {
  return {
    accountId: user.accountId,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    status: user.status,
  };
}

function stringDetail(details: Record<string, unknown> | undefined, key: string) {
  return typeof details?.[key] === "string" ? details[key] : undefined;
}

export abstract class SqliteControlPlaneOrganizationAuditStore extends SqliteControlPlaneOrganizationMemoryLifecycleStore {
  async listAuthorizedOrganizationAuditEvents(params: {
    actorUserId: string;
    limit?: number;
    cursor?: OrganizationAuditCursor;
    category?: OrganizationAuditRecord["category"];
    outcome?: NonNullable<OrganizationAuditRecord["outcome"]>;
  }): Promise<OrganizationAuditPage> {
    const limit = Number.isFinite(params.limit)
      ? Math.max(1, Math.min(Math.trunc(params.limit!), 100))
      : 50;
    return runReadTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      let query = this.query
        .selectFrom("control_audit_events")
        .leftJoin("platform_users as actor", "actor.id", "control_audit_events.actor_user_id")
        .leftJoin("managed_scopes as target_scope", (join) =>
          join
            .onRef("target_scope.id", "=", "control_audit_events.target_id")
            .on("control_audit_events.target_type", "=", "managed-scope"),
        )
        .leftJoin(
          "managed_scopes as target_parent",
          "target_parent.id",
          "target_scope.parent_scope_id",
        )
        .leftJoin(
          "managed_scopes as target_root",
          "target_root.id",
          "target_parent.parent_scope_id",
        )
        .leftJoin("platform_users as target_user", (join) =>
          join
            .onRef("target_user.id", "=", "control_audit_events.target_id")
            .on("control_audit_events.target_type", "=", "user"),
        )
        .selectAll("control_audit_events")
        .select([
          "actor.account_id as actor_account_id",
          "actor.display_name as actor_display_name",
          "actor.status as actor_status",
          "target_scope.kind as target_scope_kind",
          "target_scope.name as target_scope_name",
          "target_scope.status as target_scope_status",
          "target_parent.kind as target_parent_kind",
          "target_parent.name as target_parent_name",
          "target_parent.status as target_parent_status",
          "target_root.kind as target_root_kind",
          "target_root.name as target_root_name",
          "target_root.status as target_root_status",
          "target_user.account_id as target_user_account_id",
          "target_user.display_name as target_user_display_name",
          "target_user.status as target_user_status",
        ])
        .where((expression) =>
          expression.or([
            expression("event_type", "like", "organization.%"),
            expression("event_type", "like", "scope.%"),
          ]),
        );
      if (params.cursor) {
        query = query.where((expression) =>
          expression.or([
            expression("control_audit_events.created_at", "<", params.cursor!.occurredAt),
            expression.and([
              expression("control_audit_events.created_at", "=", params.cursor!.occurredAt),
              expression("control_audit_events.id", "<", params.cursor!.id),
            ]),
          ]),
        );
      }
      if (params.category === "other") {
        query = query.where((expression) =>
          expression.and([
            expression("event_type", "not like", "scope.create%"),
            expression("event_type", "not like", "scope.rename%"),
            expression("event_type", "not like", "scope.archive%"),
            expression("event_type", "not like", "scope.membership.%"),
            expression("event_type", "not like", "scope.primary.%"),
            expression("event_type", "not like", "organization.join.%"),
          ]),
        );
      } else if (params.category) {
        const prefix =
          params.category === "scope"
            ? "scope.create%"
            : params.category === "membership"
              ? "scope.membership.%"
              : params.category === "primary"
                ? "scope.primary.%"
                : "organization.join.%";
        if (params.category === "scope") {
          query = query.where((expression) =>
            expression.or([
              expression("event_type", "like", prefix),
              expression("event_type", "like", "scope.rename%"),
              expression("event_type", "like", "scope.archive%"),
            ]),
          );
        } else {
          query = query.where("event_type", "like", prefix);
        }
      }
      if (params.outcome) {
        query = query.where(
          sql<boolean>`json_extract(details_json, '$.outcome') = ${params.outcome}`,
        );
      }
      const rows = executeSync(
        this.db,
        query
          .orderBy("control_audit_events.created_at", "desc")
          .orderBy("control_audit_events.id", "desc")
          .limit(limit + 1),
      ).rows;
      const visibleRows = rows.slice(0, limit);
      const details = visibleRows.map((row) =>
        row.details_json ? (JSON.parse(row.details_json) as Record<string, unknown>) : undefined,
      );
      const subjectIds = details
        .map((entry) => stringDetail(entry, "userId"))
        .filter((id): id is string => Boolean(id));
      const changeScopeIds = details
        .flatMap((entry) => [
          stringDetail(entry, "priorScopeId"),
          stringDetail(entry, "resultScopeId"),
        ])
        .filter((id): id is string => Boolean(id));
      const subjects = new Map(
        subjectIds.length === 0
          ? []
          : executeSync(
              this.db,
              this.query
                .selectFrom("platform_users")
                .select(["id", "account_id", "display_name", "status"])
                .where("id", "in", subjectIds),
            ).rows.map(
              (row) =>
                [
                  row.id,
                  publicUser({
                    id: row.id,
                    accountId: row.account_id,
                    displayName: row.display_name ?? undefined,
                    status: row.status,
                  }),
                ] as const,
            ),
      );
      const changeScopes = new Map(
        changeScopeIds.length === 0
          ? []
          : executeSync(
              this.db,
              this.query
                .selectFrom("managed_scopes")
                .select(["id", "kind", "name", "status"])
                .where("id", "in", changeScopeIds),
            ).rows.map(
              (row) => [row.id, { kind: row.kind, name: row.name, status: row.status }] as const,
            ),
      );
      const items = visibleRows.map((row, index): OrganizationAuditRecord => {
        const detail = details[index];
        const rawOutcome = detail?.outcome;
        const outcome =
          rawOutcome === "succeeded" || rawOutcome === "denied" ? rawOutcome : undefined;
        const scope = minimalScope(
          row.target_scope_kind,
          row.target_scope_name,
          row.target_scope_status,
        );
        const parent = minimalScope(
          row.target_parent_kind,
          row.target_parent_name,
          row.target_parent_status,
        );
        const root = minimalScope(
          row.target_root_kind,
          row.target_root_name,
          row.target_root_status,
        );
        const targetUser = minimalUser(
          row.target_user_account_id,
          row.target_user_display_name,
          row.target_user_status,
        );
        const subjectId = stringDetail(detail, "userId");
        const actor = minimalUser(row.actor_account_id, row.actor_display_name, row.actor_status);
        const selfSubject =
          row.event_type.startsWith("organization.join.request") ||
          row.event_type === "organization.join.cancelled"
            ? actor
            : undefined;
        return {
          id: row.id,
          action: normalizedAction(row.event_type),
          category: auditCategory(row.event_type),
          occurredAt: row.created_at,
          outcome,
          reason: stringDetail(detail, "reason"),
          actor,
          subject: subjectId ? subjects.get(subjectId) : selfSubject,
          target: scope
            ? { type: "scope", scope, lineage: [root, parent, scope].filter(isPresent) }
            : targetUser
              ? { type: "user", user: targetUser }
              : { type: "unavailable", targetType: row.target_type },
          change: {
            beforeName: stringDetail(detail, "beforeName"),
            resultName: stringDetail(detail, "resultName"),
            priorRole: roleDetail(detail, "beforeRole") ?? roleDetail(detail, "priorRole"),
            resultRole: roleDetail(detail, "resultRole"),
            priorScope: changeScopes.get(stringDetail(detail, "priorScopeId") ?? ""),
            resultScope: changeScopes.get(stringDetail(detail, "resultScopeId") ?? ""),
          },
        };
      });
      const last = visibleRows.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last ? { occurredAt: last.created_at, id: last.id } : undefined,
      };
    });
  }
}

function minimalScope(
  kind: ManagedScope["kind"] | null,
  name: string | null,
  status: ManagedScope["status"] | null,
) {
  return kind && name && status ? { kind, name, status } : undefined;
}

function minimalUser(
  accountId: string | null,
  displayName: string | null,
  status: OrganizationUserSummary["status"] | null,
) {
  return accountId && status
    ? { accountId, ...(displayName ? { displayName } : {}), status }
    : undefined;
}

function roleDetail(details: Record<string, unknown> | undefined, key: string) {
  return details?.[key] === "member" || details?.[key] === "leader" ? details[key] : undefined;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
