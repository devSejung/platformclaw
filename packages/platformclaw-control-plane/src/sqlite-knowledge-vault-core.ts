import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { formatWikiDocumentLink } from "@openclaw/markdown-core";
import { sql } from "kysely";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
} from "./contracts.js";
import {
  effectiveWikiRoles,
  reconcileWikiAccess,
  writeWikiEnabled,
  bumpWikiSelection,
  recordWikiAudit,
  requireWikiRole,
} from "./knowledge-vault-access.js";
import {
  KNOWLEDGE_VAULT_LIMITS,
  type KnowledgeVault,
  type KnowledgeVaultCatalogEntry,
  type KnowledgeVaultTurnScope,
  type KnowledgeVaultDocument,
  type KnowledgeVaultDocumentSummary,
  type KnowledgeVaultRole,
  type KnowledgeVaultGraph,
  type KnowledgeVaultSnapshot,
} from "./knowledge-vault-contracts.js";
import {
  knowledgeVaultBodySnippet,
  knowledgeVaultEditableSource,
} from "./knowledge-vault-document.js";
import {
  createSyncKysely,
  executeSync,
  runImmediateTransaction,
  runReadTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import {
  ensureKnowledgeVaultSchema,
  type KnowledgeVaultDatabase,
  type KnowledgeVaultDocumentRow,
} from "./sqlite-schema-knowledge-vault.js";

export function requireKnowledgeVaultText(value: string, name: string, limit: number): string {
  const text = value.trim();
  if (!text || text.length > limit) {
    throw new ControlPlaneStateError(`${name} requires 1-${limit} characters`);
  }
  return text;
}

function summary(row: KnowledgeVaultDocumentRow): KnowledgeVaultDocumentSummary {
  return {
    id: row.id,
    vaultId: row.vault_id,
    title: row.title,
    link: formatWikiDocumentLink(row.logical_path, row.title),
    snippet: knowledgeVaultBodySnippet(row.content),
    logicalPath: row.logical_path,
    revision: row.revision,
    updatedAt: row.updated_at,
    compile: {
      status: row.compile_status,
      indexedRevision: row.indexed_revision,
      error: row.compile_error,
      attempts: row.compile_attempts,
      retryAt: row.retry_at,
    },
  };
}

export abstract class SqliteKnowledgeVaultCore {
  private ready = false;
  protected readonly query = createSyncKysely<KnowledgeVaultDatabase>();
  constructor(protected readonly db: DatabaseSync) {}

  protected ensure(): void {
    if (!this.ready) {
      ensureKnowledgeVaultSchema(this.db);
      this.ready = true;
    }
  }

  protected activeUser(userId: string): void {
    this.ensure();
    const user = takeFirstSync(
      this.db,
      this.query
        .selectFrom("platform_users")
        .select("id")
        .where("id", "=", userId)
        .where("status", "=", "active"),
    );
    if (!user) {
      throw new ControlPlaneAuthorizationError("Active employee required");
    }
  }

  userIdForAgent(agentId: string): string {
    this.ensure();
    const binding = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .innerJoin("platform_users", "platform_users.id", "agent_bindings.user_id")
        .select("platform_users.id")
        .where("agent_bindings.agent_id", "=", agentId)
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active")
        .where("platform_users.status", "=", "active"),
    );
    if (!binding) {
      throw new ControlPlaneAuthorizationError("Active personal agent required");
    }
    return binding.id;
  }

  personalAgentForUser(userId: string): string {
    this.activeUser(userId);
    const binding = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .select("agent_id")
        .where("user_id", "=", userId)
        .where("kind", "=", "personal")
        .where("state", "=", "active"),
    );
    if (!binding) {
      throw new ControlPlaneAuthorizationError("Active personal Wiki required");
    }
    return binding.agent_id;
  }

  protected access(
    userId: string,
    vaultId: string,
    permission: "read" | "edit" | "owner" | "export" = "read",
  ): KnowledgeVault {
    this.activeUser(userId);
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("knowledge_vaults").selectAll().where("id", "=", vaultId),
    );
    const role = effectiveWikiRoles(this.db).get(vaultId)?.get(userId);
    if (
      !row ||
      !role ||
      (permission === "edit" && role === "reader") ||
      (permission === "owner" && role !== "owner") ||
      (permission === "export" && role === "reader")
    ) {
      throw new ControlPlaneAuthorizationError("Wiki or requested permission is unavailable");
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      type: "shared",
      role,
      canRead: true,
      canEdit: role !== "reader",
      canManageMembers: role === "owner",
      canExport: role !== "reader",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listVaults(userId: string): KnowledgeVaultCatalogEntry[] {
    this.activeUser(userId);
    const connected = new Set(this.connectionScope(userId).vaultIds);
    const blocked = new Set(
      executeSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_enable_outcomes")
          .select("vault_id")
          .where("user_id", "=", userId),
      ).rows.map((row) => row.vault_id),
    );
    const roles = effectiveWikiRoles(this.db);
    const admin =
      takeFirstSync(
        this.db,
        this.query.selectFrom("platform_users").select("global_role").where("id", "=", userId),
      )?.global_role === "admin";
    return executeSync(
      this.db,
      this.query.selectFrom("knowledge_vaults").selectAll().orderBy("name").orderBy("id"),
    ).rows.map((row) => {
      const role = roles.get(row.id)?.get(userId) ?? null;
      const entry: KnowledgeVaultCatalogEntry = {
        id: row.id,
        name: row.name,
        description: row.description,
        type: "shared",
        role,
        canRead: role !== null,
        canEdit: role === "editor" || role === "owner",
        canManageMembers: role === "owner",
        canExport: role === "editor" || role === "owner",
        canRecoverOwner: admin && ![...(roles.get(row.id)?.values() ?? [])].includes("owner"),
        connected: role !== null && connected.has(row.id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      if (role) {
        if (blocked.has(row.id)) {
          entry.connectionIssue = "capacity";
        }
        entry.documentCount = takeFirstSync(
          this.db,
          this.query
            .selectFrom("knowledge_vault_documents")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("vault_id", "=", row.id),
        )!.count;
        entry.attachmentCount = takeFirstSync(
          this.db,
          this.query
            .selectFrom("knowledge_vault_attachments")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("vault_id", "=", row.id),
        )!.count;
      }
      return entry;
    });
  }

  connectionScope(userId: string): KnowledgeVaultTurnScope {
    this.activeUser(userId);
    const read = (): KnowledgeVaultTurnScope => ({
      personalEnabled:
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("knowledge_vault_personal_preferences")
            .select("enabled")
            .where("user_id", "=", userId),
        )?.enabled !== 0,
      revision:
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("knowledge_vault_selections")
            .select("revision")
            .where("user_id", "=", userId),
        )?.revision ?? 0,
      vaultIds: executeSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_connections")
          .select("vault_id")
          .where("user_id", "=", userId)
          .orderBy("vault_id"),
      ).rows.map((row) => row.vault_id),
    });
    return this.db.isTransaction ? read() : runReadTransaction(this.db, read);
  }

  setConnection(params: { userId: string; vaultId: string; connected: boolean }): void {
    this.activeUser(params.userId);
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId);
      writeWikiEnabled(this.db, params.userId, params.vaultId, params.connected);
    });
  }

  setPersonalEnabled(userId: string, enabled: boolean): void {
    this.activeUser(userId);
    runImmediateTransaction(this.db, () => {
      if (this.connectionScope(userId).personalEnabled === enabled) {
        return;
      }
      executeSync(
        this.db,
        this.query
          .insertInto("knowledge_vault_personal_preferences")
          .values({ user_id: userId, enabled: Number(enabled) })
          .onConflict((oc) => oc.column("user_id").doUpdateSet({ enabled: Number(enabled) })),
      );
      bumpWikiSelection(this.db, userId);
    });
  }

  createVault(params: { userId: string; name: string; description?: string }): KnowledgeVault {
    this.activeUser(params.userId);
    const name = requireKnowledgeVaultText(params.name, "Vault name", 160);
    if ((params.description ?? "").length > 2000) {
      throw new ControlPlaneStateError("Vault description exceeds 2000 characters");
    }
    const id = randomUUID();
    const now = Date.now();
    runImmediateTransaction(this.db, () => {
      this.activeUser(params.userId);
      executeSync(
        this.db,
        this.query.insertInto("knowledge_vaults").values({
          id,
          name,
          description: params.description ?? "",
          created_at: now,
          updated_at: now,
        }),
      );
      executeSync(
        this.db,
        this.query.insertInto("knowledge_vault_members").values({
          vault_id: id,
          user_id: params.userId,
          role: "owner",
          can_export: 1,
        }),
      );
      reconcileWikiAccess(this.db, id);
    });
    return this.access(params.userId, id);
  }

  renameVault(params: { userId: string; vaultId: string; name: string }): KnowledgeVault {
    const name = requireKnowledgeVaultText(params.name, "Vault name", 160);
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId, "owner");
      executeSync(
        this.db,
        this.query
          .updateTable("knowledge_vaults")
          .set({ name, updated_at: Date.now() })
          .where("id", "=", params.vaultId),
      );
      recordWikiAudit(this.db, params.userId, "wiki.vault.renamed", params.vaultId, { name });
    });
    return this.access(params.userId, params.vaultId);
  }

  deleteVault(params: { userId: string; vaultId: string }): { deleted: true; vaultId: string } {
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId, "owner");
      const connectedUsers = executeSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_connections")
          .select("user_id")
          .where("vault_id", "=", params.vaultId),
      ).rows.map((row) => row.user_id);
      recordWikiAudit(this.db, params.userId, "wiki.vault.deleted", params.vaultId, {});
      executeSync(
        this.db,
        this.query.deleteFrom("knowledge_vault_connections").where("vault_id", "=", params.vaultId),
      );
      executeSync(
        this.db,
        this.query.deleteFrom("knowledge_vaults").where("id", "=", params.vaultId),
      );
      for (const userId of connectedUsers) {
        bumpWikiSelection(this.db, userId);
      }
    });
    return { deleted: true, vaultId: params.vaultId };
  }

  snapshot(params: { userId: string; vaultId?: string }): KnowledgeVaultSnapshot {
    this.activeUser(params.userId);
    const read = (): KnowledgeVaultSnapshot => {
      const vaults = this.listVaults(params.userId);
      const selectionRevision = this.connectionScope(params.userId).revision;
      if (!params.vaultId) {
        return { vaults, selectionRevision, ownRequests: [], pendingRequests: [] };
      }
      const vault = this.access(params.userId, params.vaultId);
      const documents = executeSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_documents")
          .select([
            "id",
            "vault_id",
            "title",
            "content",
            "logical_path",
            "revision",
            "updated_at",
            "compile_status",
            "indexed_revision",
            "compile_error",
            "compile_attempts",
            "retry_at",
          ])
          .where("vault_id", "=", vault.id)
          .orderBy("logical_path"),
      ).rows.map(summary);
      const members = executeSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_members as member")
          .innerJoin("platform_users as user", "user.id", "member.user_id")
          .select([
            "user.id",
            "user.account_id",
            "user.display_name",
            "member.role",
            "member.can_export",
          ])
          .where("member.vault_id", "=", vault.id)
          .orderBy("user.account_id"),
      ).rows.map((row) => ({
        userId: row.id,
        accountId: row.account_id,
        displayName: row.display_name ?? row.account_id,
        role: row.role,
      }));
      const attachments = executeSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_attachments")
          .select(["path", "media_type", "revision", sql<number>`length(content)`.as("bytes")])
          .where("vault_id", "=", vault.id)
          .orderBy("path"),
      ).rows.map((row) => ({
        path: row.path,
        mediaType: row.media_type,
        bytes: row.bytes,
        revision: row.revision,
      }));
      const graph = this.graph(vault.id);
      return {
        vaults,
        selectionRevision,
        ownRequests: [],
        pendingRequests: [],
        selected: {
          vault,
          documents,
          members: vault.canManageMembers ? members : [],
          grants: [],
          attachments,
          graph,
        },
      };
    };
    return this.db.isTransaction ? read() : runReadTransaction(this.db, read);
  }

  private graph(vaultId: string): KnowledgeVaultGraph {
    // Caller owns the authorized read transaction. Both endpoints must stay in that Vault;
    // source summaries disclose when these accepted links lag behind an edited document.
    const links = this.query
      .selectFrom("knowledge_vault_links as link")
      .innerJoin("knowledge_vault_documents as source", "source.id", "link.document_id")
      .leftJoin("knowledge_vault_documents as target", (join) =>
        join
          .onRef("target.id", "=", "link.target_document_id")
          .onRef("target.vault_id", "=", "source.vault_id"),
      )
      .where("source.vault_id", "=", vaultId);
    const edges = executeSync(
      this.db,
      links
        .select(["source.id as source", "target.id as target"])
        .where("target.id", "is not", null)
        .distinct()
        .orderBy("source.id")
        .orderBy("target.id")
        .limit(KNOWLEDGE_VAULT_LIMITS.graphEdges + 1),
    ).rows;
    const unresolvedLinks = takeFirstSync(
      this.db,
      links.select(({ fn }) => fn.countAll<number>().as("count")).where("target.id", "is", null),
    )!.count;
    return {
      edges: edges
        .slice(0, KNOWLEDGE_VAULT_LIMITS.graphEdges)
        .map((edge) => ({ source: edge.source, target: edge.target! })),
      unresolvedLinks,
      truncated: edges.length > KNOWLEDGE_VAULT_LIMITS.graphEdges,
    };
  }

  setMember(params: {
    userId: string;
    vaultId: string;
    memberUserId?: string;
    accountId?: string;
    role: KnowledgeVaultRole;
  }): void {
    this.ensure();
    const role = requireWikiRole(params.role);
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId, "owner");
      const member = params.memberUserId
        ? { id: params.memberUserId }
        : takeFirstSync(
            this.db,
            this.query
              .selectFrom("platform_users")
              .select("id")
              .where("account_id", "=", (params.accountId ?? "").trim().toLowerCase()),
          );
      if (!member) {
        throw new ControlPlaneNotFoundError("user", params.accountId ?? "");
      }
      this.activeUser(member.id);
      executeSync(
        this.db,
        this.query
          .insertInto("knowledge_vault_members")
          .values({
            vault_id: params.vaultId,
            user_id: member.id,
            role,
            can_export: Number(role !== "reader"),
          })
          .onConflict((oc) =>
            oc
              .columns(["vault_id", "user_id"])
              .doUpdateSet({ role, can_export: Number(role !== "reader") }),
          ),
      );
      reconcileWikiAccess(this.db, params.vaultId);
      recordWikiAudit(this.db, params.userId, "wiki.member.set", params.vaultId, {
        userId: member.id,
        role,
      });
    });
  }

  removeMember(params: { userId: string; vaultId: string; memberUserId: string }): void {
    this.ensure();
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId, "owner");
      executeSync(
        this.db,
        this.query
          .deleteFrom("knowledge_vault_members")
          .where("vault_id", "=", params.vaultId)
          .where("user_id", "=", params.memberUserId),
      );
      reconcileWikiAccess(this.db, params.vaultId);
      recordWikiAudit(this.db, params.userId, "wiki.member.removed", params.vaultId, {
        userId: params.memberUserId,
      });
    });
  }

  protected document(vaultId: string, documentId: string): KnowledgeVaultDocumentRow {
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_documents")
        .selectAll()
        .where("id", "=", documentId)
        .where("vault_id", "=", vaultId),
    );
    if (!row) {
      throw new ControlPlaneNotFoundError("knowledge-vault-document", documentId);
    }
    return row;
  }

  protected requireCapacity(vaultId: string, addedBytes: number, addedFiles: number): void {
    const documents = takeFirstSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_documents")
        .select([
          sql<number>`count(*)`.as("count"),
          sql<number>`coalesce(sum(length(cast(content AS BLOB))),0)`.as("bytes"),
        ])
        .where("vault_id", "=", vaultId),
    )!;
    const attachments = takeFirstSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_attachments")
        .select([
          sql<number>`count(*)`.as("count"),
          sql<number>`coalesce(sum(length(content)),0)`.as("bytes"),
        ])
        .where("vault_id", "=", vaultId),
    )!;
    // Reserve 1 MiB for metadata and ZIP overhead so incompressible sources remain exportable.
    if (
      documents.count + attachments.count + addedFiles + 1 > KNOWLEDGE_VAULT_LIMITS.files ||
      documents.bytes + attachments.bytes + addedBytes >
        KNOWLEDGE_VAULT_LIMITS.archiveBytes - KNOWLEDGE_VAULT_LIMITS.documentBytes
    ) {
      throw new ControlPlaneStateError("Vault capacity reached (999 files, 31 MiB source data)");
    }
  }

  readDocument(params: {
    userId: string;
    vaultId: string;
    documentId: string;
  }): KnowledgeVaultDocument {
    this.access(params.userId, params.vaultId);
    const row = this.document(params.vaultId, params.documentId);
    const links = executeSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_links as link")
        .leftJoin("knowledge_vault_documents as target", (join) =>
          join
            .onRef("target.id", "=", "link.target_document_id")
            .on("target.vault_id", "=", row.vault_id),
        )
        .select([
          "target.id as target_document_id",
          "link.target_path",
          "target.logical_path",
          "target.title",
        ])
        .where("link.document_id", "=", row.id)
        .orderBy("link.target_path"),
    ).rows.map((link) => ({
      target: link.target_path,
      documentId: link.target_document_id,
      logicalPath: link.logical_path ?? link.target_path,
      title: link.title ?? link.target_path,
    }));
    const backlinks = executeSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_links as link")
        .innerJoin("knowledge_vault_documents as source", "source.id", "link.document_id")
        .select(["source.id", "source.logical_path", "source.title"])
        .where("link.target_document_id", "=", row.id)
        .where("source.vault_id", "=", row.vault_id)
        .orderBy("source.logical_path"),
    ).rows.map((link) => ({
      target: link.logical_path,
      documentId: link.id,
      logicalPath: link.logical_path,
      title: link.title,
    }));
    return {
      ...summary(row),
      content: row.content,
      sourceContent: row.content,
      editableContent: knowledgeVaultEditableSource(row.content).body,
      editMode: "body",
      links,
      backlinks,
    };
  }
}
