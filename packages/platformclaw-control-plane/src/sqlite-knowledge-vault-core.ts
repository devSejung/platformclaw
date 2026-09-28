import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
} from "./contracts.js";
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

function summary(row: Omit<KnowledgeVaultDocumentRow, "content">): KnowledgeVaultDocumentSummary {
  return {
    id: row.id,
    vaultId: row.vault_id,
    title: row.title,
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

  protected access(
    userId: string,
    vaultId: string,
    permission: "read" | "edit" | "owner" | "export" = "read",
  ): KnowledgeVault {
    this.activeUser(userId);
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("knowledge_vaults as vault")
        .innerJoin("knowledge_vault_members as member", "member.vault_id", "vault.id")
        .selectAll("vault")
        .select(["member.role", "member.can_export"])
        .where("vault.id", "=", vaultId)
        .where("member.user_id", "=", userId),
    );
    if (
      !row ||
      (permission === "edit" && row.role === "reader") ||
      (permission === "owner" && row.role !== "owner") ||
      (permission === "export" && !row.can_export)
    ) {
      throw new ControlPlaneAuthorizationError("Vault or requested permission is unavailable");
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      type: "shared",
      role: row.role,
      canEdit: row.role !== "reader",
      canManageMembers: row.role === "owner",
      canExport: Boolean(row.can_export),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listVaults(userId: string): KnowledgeVaultCatalogEntry[] {
    this.activeUser(userId);
    const connected = new Set(this.connectionScope(userId).vaultIds);
    return executeSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_members")
        .select("vault_id")
        .where("user_id", "=", userId)
        .orderBy("vault_id"),
    ).rows.map((row) =>
      Object.assign(this.access(userId, row.vault_id), {
        connected: connected.has(row.vault_id),
        documentCount: takeFirstSync(
          this.db,
          this.query
            .selectFrom("knowledge_vault_documents")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("vault_id", "=", row.vault_id),
        )!.count,
        attachmentCount: takeFirstSync(
          this.db,
          this.query
            .selectFrom("knowledge_vault_attachments")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("vault_id", "=", row.vault_id),
        )!.count,
      }),
    );
  }

  connectionScope(userId: string): KnowledgeVaultTurnScope {
    this.activeUser(userId);
    const read = (): KnowledgeVaultTurnScope => ({
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

  /** Managed ACL validation belongs to the service; Shared validation stays in this store. */
  setConnection(params: { userId: string; vaultId: string; connected: boolean }): void {
    this.activeUser(params.userId);
    runImmediateTransaction(this.db, () => {
      if (!params.vaultId.startsWith("managed:")) {
        this.access(params.userId, params.vaultId);
      }
      this.writeConnection(params);
    });
  }

  protected writeConnection(params: { userId: string; vaultId: string; connected: boolean }): void {
    const existing = takeFirstSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_connections")
        .select("vault_id")
        .where("user_id", "=", params.userId)
        .where("vault_id", "=", params.vaultId),
    );
    if (Boolean(existing) === params.connected) {
      return;
    }
    if (params.connected) {
      const count = takeFirstSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_connections")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("user_id", "=", params.userId),
      )!.count;
      if (count >= KNOWLEDGE_VAULT_LIMITS.connections) {
        throw new ControlPlaneStateError(
          `At most ${KNOWLEDGE_VAULT_LIMITS.connections} Vaults can be connected; disconnect one first`,
        );
      }
      executeSync(
        this.db,
        this.query
          .insertInto("knowledge_vault_connections")
          .values({ user_id: params.userId, vault_id: params.vaultId }),
      );
    } else {
      executeSync(
        this.db,
        this.query
          .deleteFrom("knowledge_vault_connections")
          .where("user_id", "=", params.userId)
          .where("vault_id", "=", params.vaultId),
      );
    }
    executeSync(
      this.db,
      this.query
        .insertInto("knowledge_vault_selections")
        .values({ user_id: params.userId, revision: 1 })
        .onConflict((oc) =>
          oc.column("user_id").doUpdateSet((eb) => ({ revision: eb("revision", "+", 1) })),
        ),
    );
  }

  createVault(params: {
    userId: string;
    name: string;
    description?: string;
    ownerCanExport: boolean;
  }): KnowledgeVault {
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
          can_export: Number(params.ownerCanExport),
        }),
      );
      this.writeConnection({ userId: params.userId, vaultId: id, connected: true });
    });
    return this.access(params.userId, id);
  }

  snapshot(params: { userId: string; vaultId?: string }): KnowledgeVaultSnapshot {
    this.activeUser(params.userId);
    return runReadTransaction(this.db, () => {
      const vaults = this.listVaults(params.userId);
      const selectionRevision = this.connectionScope(params.userId).revision;
      if (!params.vaultId) {
        return { vaults, selectionRevision };
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
        canExport: Boolean(row.can_export),
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
        selected: { vault, documents, members, attachments, graph },
      };
    });
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
    canExport: boolean;
  }): void {
    this.ensure();
    if (!["reader", "editor", "owner"].includes(params.role)) {
      throw new ControlPlaneStateError("Invalid Vault role");
    }
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
      this.protectLastOwner(params.vaultId, member.id, params.role);
      executeSync(
        this.db,
        this.query
          .insertInto("knowledge_vault_members")
          .values({
            vault_id: params.vaultId,
            user_id: member.id,
            role: params.role,
            can_export: Number(params.canExport),
          })
          .onConflict((oc) =>
            oc
              .columns(["vault_id", "user_id"])
              .doUpdateSet({ role: params.role, can_export: Number(params.canExport) }),
          ),
      );
    });
  }

  removeMember(params: { userId: string; vaultId: string; memberUserId: string }): void {
    this.ensure();
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId, "owner");
      this.protectLastOwner(params.vaultId, params.memberUserId);
      this.writeConnection({
        userId: params.memberUserId,
        vaultId: params.vaultId,
        connected: false,
      });
      executeSync(
        this.db,
        this.query
          .deleteFrom("knowledge_vault_members")
          .where("vault_id", "=", params.vaultId)
          .where("user_id", "=", params.memberUserId),
      );
    });
  }

  private protectLastOwner(vaultId: string, userId: string, nextRole?: KnowledgeVaultRole): void {
    if (nextRole === "owner") {
      return;
    }
    const owners = executeSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_members as member")
        .innerJoin("platform_users as user", "user.id", "member.user_id")
        .select("member.user_id")
        .where("member.vault_id", "=", vaultId)
        .where("member.role", "=", "owner")
        .where("user.status", "=", "active"),
    ).rows;
    if (owners.length === 1 && owners[0]!.user_id === userId) {
      throw new ControlPlaneConflictError(
        "knowledge_vault_changed",
        "Add another active Owner before removing the last Owner",
      );
    }
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
        .leftJoin("knowledge_vault_documents as target", "target.id", "link.target_document_id")
        .select([
          "link.target_document_id",
          "link.target_path",
          "target.logical_path",
          "target.title",
        ])
        .where("link.document_id", "=", row.id)
        .orderBy("link.target_path"),
    ).rows.map((link) => ({
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
        .orderBy("source.logical_path"),
    ).rows.map((link) => ({
      documentId: link.id,
      logicalPath: link.logical_path,
      title: link.title,
    }));
    return { ...summary(row), content: row.content, links, backlinks };
  }
}
