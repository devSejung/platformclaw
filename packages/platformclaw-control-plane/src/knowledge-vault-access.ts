import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ControlPlaneConflictError, ControlPlaneStateError } from "./contracts.js";
import { KNOWLEDGE_VAULT_LIMITS, type KnowledgeVaultRole } from "./knowledge-vault-contracts.js";
import { createSyncKysely, executeSync, takeFirstSync } from "./kysely-sync.js";
import type { KnowledgeVaultDatabase } from "./sqlite-schema-knowledge-vault.js";

const query = createSyncKysely<KnowledgeVaultDatabase>();
const rank: Record<KnowledgeVaultRole, number> = { reader: 1, editor: 2, owner: 3 };

/** Grants target direct membership only; hierarchy is validated, never expanded. */
export function activeWikiOrganizations(db: DatabaseSync) {
  const rows = executeSync(db, query.selectFrom("managed_scopes").selectAll()).rows;
  const scopes = new Map(rows.map((row) => [row.id, row]));
  return rows.filter((scope) => {
    if (scope.status !== "active") {
      return false;
    }
    if (scope.kind === "team") {
      return scope.parent_scope_id === null;
    }
    const parent = scopes.get(scope.parent_scope_id ?? "");
    if (parent?.status !== "active") {
      return false;
    }
    if (scope.kind === "group") {
      return parent.kind === "team" && parent.parent_scope_id === null;
    }
    const team = scopes.get(parent.parent_scope_id ?? "");
    return (
      parent.kind === "group" &&
      team?.kind === "team" &&
      team.status === "active" &&
      team.parent_scope_id === null
    );
  });
}

export function effectiveWikiRoles(db: DatabaseSync): Map<string, Map<string, KnowledgeVaultRole>> {
  const users = new Set(
    executeSync(
      db,
      query.selectFrom("platform_users").select("id").where("status", "=", "active"),
    ).rows.map((user) => user.id),
  );
  const roles = new Map<string, Map<string, KnowledgeVaultRole>>();
  const add = (vaultId: string, userId: string, role: KnowledgeVaultRole) => {
    if (!users.has(userId)) {
      return;
    }
    const members = roles.get(vaultId) ?? new Map<string, KnowledgeVaultRole>();
    if (rank[role] > (rank[members.get(userId)!] ?? 0)) {
      members.set(userId, role);
    }
    roles.set(vaultId, members);
  };
  for (const member of executeSync(db, query.selectFrom("knowledge_vault_members").selectAll())
    .rows) {
    add(member.vault_id, member.user_id, member.role);
  }
  const scopes = new Set(activeWikiOrganizations(db).map((scope) => scope.id));
  const grants = executeSync(
    db,
    query
      .selectFrom("knowledge_vault_organization_grants as grant")
      .innerJoin("managed_scope_memberships as member", "member.scope_id", "grant.scope_id")
      .select(["grant.vault_id", "grant.scope_id", "grant.role", "member.user_id"]),
  ).rows;
  for (const grant of grants) {
    if (scopes.has(grant.scope_id)) {
      add(grant.vault_id, grant.user_id, grant.role);
    }
  }
  return roles;
}

export function bumpWikiSelection(db: DatabaseSync, userId: string): void {
  executeSync(
    db,
    query
      .insertInto("knowledge_vault_selections")
      .values({ user_id: userId, revision: 1 })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet((eb) => ({ revision: eb("revision", "+", 1) })),
      ),
  );
}

export function writeWikiEnabled(
  db: DatabaseSync,
  userId: string,
  vaultId: string,
  enabled: boolean,
  automatic = false,
): void {
  const prior = takeFirstSync(
    db,
    query
      .selectFrom("knowledge_vault_connections")
      .select("vault_id")
      .where("user_id", "=", userId)
      .where("vault_id", "=", vaultId),
  );
  if (enabled && !prior) {
    const count = takeFirstSync(
      db,
      query
        .selectFrom("knowledge_vault_connections")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("user_id", "=", userId),
    )!.count;
    if (count >= KNOWLEDGE_VAULT_LIMITS.connections) {
      if (!automatic) {
        throw new ControlPlaneStateError(
          "Disable another Shared Wiki before enabling this Wiki (256 enabled limit)",
        );
      }
      // Directory changes must succeed; record why newly granted access was not enabled.
      executeSync(
        db,
        query
          .insertInto("knowledge_vault_enable_outcomes")
          .values({ user_id: userId, vault_id: vaultId, issue: "capacity" })
          .onConflict((oc) => oc.columns(["user_id", "vault_id"]).doNothing()),
      );
      return;
    }
  }
  executeSync(
    db,
    query
      .deleteFrom("knowledge_vault_enable_outcomes")
      .where("user_id", "=", userId)
      .where("vault_id", "=", vaultId),
  );
  if (Boolean(prior) === enabled) {
    return;
  }
  if (enabled) {
    executeSync(
      db,
      query
        .insertInto("knowledge_vault_connections")
        .values({ user_id: userId, vault_id: vaultId }),
    );
  } else {
    executeSync(
      db,
      query
        .deleteFrom("knowledge_vault_connections")
        .where("user_id", "=", userId)
        .where("vault_id", "=", vaultId),
    );
  }
  bumpWikiSelection(db, userId);
}

/** Called inside the grant/membership transaction: readers never infer access transitions. */
export function reconcileWikiAccess(db: DatabaseSync, requireOwnerVaultId?: string): void {
  const roles = effectiveWikiRoles(db);
  if (requireOwnerVaultId) {
    if (![...(roles.get(requireOwnerVaultId)?.values() ?? [])].includes("owner")) {
      throw new ControlPlaneConflictError(
        "knowledge_vault_changed",
        "Assign another active Wiki Owner before removing the last effective Owner",
      );
    }
  }
  const previous = executeSync(
    db,
    query.selectFrom("knowledge_vault_access_states").selectAll(),
  ).rows;
  const states = new Map(previous.map((row) => [`${row.vault_id}\0${row.user_id}`, row]));
  const current = [...roles].flatMap(([vaultId, members]) =>
    [...members.keys()].map((userId) => ({ vault_id: vaultId, user_id: userId, accessible: 1 })),
  );
  for (const row of [
    ...current,
    ...previous
      .filter((prior) => !roles.get(prior.vault_id)?.has(prior.user_id))
      .map((prior) => ({ vault_id: prior.vault_id, user_id: prior.user_id, accessible: 0 })),
  ]) {
    const prior = states.get(`${row.vault_id}\0${row.user_id}`);
    if (prior?.accessible === row.accessible) {
      continue;
    }
    executeSync(
      db,
      query
        .insertInto("knowledge_vault_access_states")
        .values(row)
        .onConflict((oc) =>
          oc.columns(["user_id", "vault_id"]).doUpdateSet({ accessible: row.accessible }),
        ),
    );
    // A role change or redundant grant keeps the manual preference; only loss/regain changes it.
    writeWikiEnabled(db, row.user_id, row.vault_id, Boolean(row.accessible), true);
  }
}

export function recordWikiAudit(
  db: DatabaseSync,
  actorId: string,
  eventType: string,
  vaultId: string,
  details: Record<string, unknown>,
): void {
  executeSync(
    db,
    query.insertInto("control_audit_events").values({
      id: randomUUID(),
      actor_user_id: actorId,
      event_type: eventType,
      target_type: "knowledge-vault",
      target_id: vaultId,
      created_at: Date.now(),
      details_json: JSON.stringify(details),
    }),
  );
}

export function requireWikiRole(value: string): KnowledgeVaultRole {
  if (value !== "reader" && value !== "editor" && value !== "owner") {
    throw new ControlPlaneStateError("Choose Reader, Editor or Owner");
  }
  return value;
}
