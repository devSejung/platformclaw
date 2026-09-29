import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { formatWikiDocumentLink } from "@openclaw/markdown-core";
import { sql } from "kysely";
import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
} from "./contracts.js";
import {
  effectiveWikiRoles,
  reconcileWikiAccess,
  recordWikiAudit,
} from "./knowledge-vault-access.js";
import {
  decodeKnowledgeVaultArchive,
  encodeKnowledgeVaultArchive,
  requireKnowledgeVaultMediaType,
} from "./knowledge-vault-archive.js";
import {
  compileKnowledgeVaultDocument,
  createKnowledgeVaultLinkResolver,
  knowledgeVaultPath,
} from "./knowledge-vault-compiler.js";
import {
  KNOWLEDGE_VAULT_LIMITS,
  KnowledgeVaultSearchError,
  type KnowledgeSearchHit,
  type KnowledgeVault,
  type KnowledgeVaultDocument,
  type KnowledgeVaultDocumentInput,
  type KnowledgeVaultSnapshot,
} from "./knowledge-vault-contracts.js";
import {
  knowledgeVaultEditableSource,
  resolveKnowledgeVaultDocumentMetadata,
} from "./knowledge-vault-document.js";
import {
  executeSync,
  runImmediateTransaction,
  runReadTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import { requireKnowledgeVaultText } from "./sqlite-knowledge-vault-core.js";
import { SqliteKnowledgeVaultSharingStore } from "./sqlite-knowledge-vault-sharing.js";

export class SqliteKnowledgeVaultStore extends SqliteKnowledgeVaultSharingStore {
  constructor(
    db: DatabaseSync,
    private readonly compiler = compileKnowledgeVaultDocument,
  ) {
    super(db);
  }
  saveDocument(params: KnowledgeVaultDocumentInput): KnowledgeVaultDocument {
    this.access(params.userId, params.vaultId, "edit");
    const id = params.documentId ?? randomUUID();
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId, "edit");
      const prior = params.documentId ? this.document(params.vaultId, id) : undefined;
      if (prior && prior.revision !== params.expectedRevision) {
        throw new ControlPlaneConflictError(
          "knowledge_vault_changed",
          "Document changed; reload before saving",
        );
      }
      const content = prior
        ? knowledgeVaultEditableSource(prior.content).prefix + params.content
        : params.content;
      // Allocate generated paths under the write lock so concurrent creates cannot overwrite.
      const { title, logicalPath } = this.documentMetadata({ ...params, content }, prior);
      const collision = takeFirstSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_documents")
          .select("id")
          .where("vault_id", "=", params.vaultId)
          .where("logical_path", "=", logicalPath),
      );
      if (collision && collision.id !== id) {
        throw new ControlPlaneConflictError(
          "knowledge_vault_changed",
          "Document path already exists; choose a new path",
        );
      }
      this.requireCapacity(
        params.vaultId,
        Buffer.byteLength(content) - Buffer.byteLength(prior?.content ?? ""),
        prior ? 0 : 1,
      );
      const now = Date.now();
      const values = {
        title,
        logical_path: logicalPath,
        content,
        revision: (prior?.revision ?? 0) + 1,
        updated_at: now,
        compile_status: "pending" as const,
        compile_error: null,
        compile_attempts: 0,
        retry_at: now,
      };
      if (prior) {
        executeSync(
          this.db,
          this.query.updateTable("knowledge_vault_documents").set(values).where("id", "=", id),
        );
      } else {
        executeSync(
          this.db,
          this.query
            .insertInto("knowledge_vault_documents")
            .values({ ...values, id, vault_id: params.vaultId, indexed_revision: null }),
        );
      }
      executeSync(
        this.db,
        this.query
          .updateTable("knowledge_vaults")
          .set({ updated_at: now })
          .where("id", "=", params.vaultId),
      );
    });
    this.compileDocument(id);
    return this.readDocument({ ...params, documentId: id });
  }

  deleteDocument(params: {
    userId: string;
    vaultId: string;
    documentId: string;
    expectedRevision: number | string;
  }) {
    this.access(params.userId, params.vaultId, "edit");
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId, "edit");
      const document = this.document(params.vaultId, params.documentId);
      if (document.revision !== params.expectedRevision) {
        throw new ControlPlaneConflictError(
          "knowledge_vault_changed",
          "Document changed; reload before deleting",
        );
      }
      // Keep the authored target path as unresolved; cascade only the deleted page's derived data.
      executeSync(
        this.db,
        this.query
          .updateTable("knowledge_vault_links")
          .set({ target_document_id: null })
          .where("target_document_id", "=", document.id),
      );
      executeSync(
        this.db,
        this.query.deleteFrom("knowledge_vault_documents").where("id", "=", document.id),
      );
      this.resolveLinks(params.vaultId);
      executeSync(
        this.db,
        this.query
          .updateTable("knowledge_vaults")
          .set({ updated_at: Date.now() })
          .where("id", "=", params.vaultId),
      );
      recordWikiAudit(this.db, params.userId, "wiki.document.deleted", params.vaultId, {
        documentId: document.id,
        revision: document.revision,
      });
    });
    return { deleted: true, documentId: params.documentId };
  }

  previewDocument(params: KnowledgeVaultDocumentInput): { title: string; logicalPath: string } {
    this.access(params.userId, params.vaultId, "edit");
    return runReadTransaction(this.db, () => this.documentMetadata(params));
  }

  private documentMetadata(
    params: KnowledgeVaultDocumentInput,
    prior?: { title: string; logical_path: string },
  ) {
    const metadata = resolveKnowledgeVaultDocumentMetadata(params, prior);
    if (params.logicalPath !== undefined || prior) {
      return metadata;
    }
    const paths = new Set(
      executeSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_documents")
          .select("logical_path")
          .where("vault_id", "=", params.vaultId),
      ).rows.map((row) => row.logical_path),
    );
    const stem = metadata.logicalPath.slice(0, -3);
    for (let suffix = 2; paths.has(metadata.logicalPath); suffix++) {
      metadata.logicalPath = `${stem}-${suffix}.md`;
    }
    return metadata;
  }

  private resolveLinks(vaultId: string): void {
    const documents = executeSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_documents")
        .select(["id", "logical_path", "title"])
        .where("vault_id", "=", vaultId),
    ).rows;
    const ids = new Set(documents.map((document) => document.id));
    if (!ids.size) {
      return;
    }
    const resolve = createKnowledgeVaultLinkResolver(documents);
    const links = executeSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_links")
        .selectAll()
        .where("document_id", "in", [...ids]),
    ).rows;
    for (const link of links) {
      const matches = resolve(link.target_path);
      // Existing identity survives moves/path reuse; ambiguous current names are always unresolved.
      const target =
        matches.length > 1
          ? null
          : link.target_document_id && ids.has(link.target_document_id)
            ? link.target_document_id
            : (matches[0]?.id ?? null);
      if (target !== link.target_document_id) {
        executeSync(
          this.db,
          this.query
            .updateTable("knowledge_vault_links")
            .set({ target_document_id: target })
            .where("document_id", "=", link.document_id)
            .where("target_path", "=", link.target_path),
        );
      }
    }
  }

  private compileDocument(documentId: string): void {
    const source = takeFirstSync(
      this.db,
      this.query.selectFrom("knowledge_vault_documents").selectAll().where("id", "=", documentId),
    );
    if (!source) {
      return;
    }
    try {
      // Compute before BEGIN. Only a successful, revision-matched snapshot replaces the old index.
      const derived = this.compiler(source.content, source.logical_path);
      runImmediateTransaction(this.db, () => {
        const current = this.document(source.vault_id, source.id);
        if (current.revision !== source.revision) {
          return;
        }
        const previous = executeSync(
          this.db,
          this.query
            .selectFrom("knowledge_vault_links")
            .selectAll()
            .where("document_id", "=", source.id),
        ).rows;
        executeSync(
          this.db,
          this.query.deleteFrom("knowledge_vault_chunks").where("document_id", "=", source.id),
        );
        executeSync(
          this.db,
          this.query.deleteFrom("knowledge_vault_links").where("document_id", "=", source.id),
        );
        for (const [ordinal, content] of derived.chunks.entries()) {
          executeSync(
            this.db,
            this.query.insertInto("knowledge_vault_chunks").values({
              document_id: source.id,
              ordinal,
              content,
              title: source.title,
              revision: source.revision,
            }),
          );
        }
        for (const targetPath of derived.links) {
          executeSync(
            this.db,
            this.query.insertInto("knowledge_vault_links").values({
              document_id: source.id,
              target_path: targetPath,
              target_document_id:
                previous.find((link) => link.target_path === targetPath)?.target_document_id ??
                null,
            }),
          );
        }
        this.resolveLinks(source.vault_id);
        executeSync(
          this.db,
          this.query
            .updateTable("knowledge_vault_documents")
            .set({
              compile_status: "ready",
              indexed_revision: source.revision,
              compile_error: null,
              compile_attempts: source.compile_attempts + 1,
              retry_at: null,
            })
            .where("id", "=", source.id),
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown compiler failure";
      executeSync(
        this.db,
        this.query
          .updateTable("knowledge_vault_documents")
          .set({
            compile_status: "failed",
            compile_error: message.slice(0, 500),
            compile_attempts: source.compile_attempts + 1,
            retry_at:
              Date.now() + Math.min(60_000 * 2 ** Math.min(source.compile_attempts, 6), 3_600_000),
          })
          .where("id", "=", source.id)
          .where("revision", "=", source.revision),
      );
    }
  }

  rebuild(params: {
    userId: string;
    vaultId: string;
    documentId?: string;
  }): KnowledgeVaultSnapshot {
    this.access(params.userId, params.vaultId, "edit");
    let query = this.query
      .selectFrom("knowledge_vault_documents")
      .select("id")
      .where("vault_id", "=", params.vaultId);
    if (params.documentId) {
      this.document(params.vaultId, params.documentId);
      query = query.where("id", "=", params.documentId);
    }
    for (const row of executeSync(this.db, query.orderBy("id")).rows) {
      this.compileDocument(row.id);
    }
    return this.snapshot(params);
  }

  retryFailed(now = Date.now()): void {
    this.ensure();
    const pending = executeSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_documents")
        .select("id")
        .where("compile_status", "!=", "ready")
        .where("retry_at", "<=", now)
        .orderBy("retry_at")
        .limit(20),
    ).rows;
    for (const row of pending) {
      this.compileDocument(row.id);
    }
  }

  search(params: {
    userId: string;
    query: string;
    vaultId?: string;
    vaultIds?: readonly string[];
    maxResults?: number;
  }): KnowledgeSearchHit[] {
    this.activeUser(params.userId);
    const needle = requireKnowledgeVaultText(params.query, "Search query", 1000).toLowerCase();
    if (params.vaultId) {
      this.access(params.userId, params.vaultId);
    }
    // Literal Unicode tokens, without language-specific stopwords. Require every token
    // somewhere in the document; separate chunks must not hide a matching document.
    const tokens = [...new Set(needle.match(/[\p{L}\p{N}_]+/gu) ?? [])];
    if (!tokens.length || tokens.length > 16) {
      throw new KnowledgeVaultSearchError(
        "vault-query-invalid",
        "Search query requires 1-16 distinct words or identifiers",
        "Retry with 1-16 specific keywords or a document ID instead of a long question.",
      );
    }
    const tokenScore = (token: string, alias: string) => {
      const pattern = `%${token.replaceAll("_", "\\_")}%`;
      return sql<number>`(CASE WHEN lower(${sql.ref(`${alias}.title`)}) LIKE ${pattern} ESCAPE '\\' THEN 4 ELSE 0 END + CASE WHEN lower(doc.logical_path) LIKE ${pattern} ESCAPE '\\' THEN 2 ELSE 0 END + CASE WHEN lower(doc.id) LIKE ${pattern} ESCAPE '\\' THEN 8 ELSE 0 END + CASE WHEN lower(${sql.ref(`${alias}.content`)}) LIKE ${pattern} ESCAPE '\\' THEN 1 ELSE 0 END)`;
    };
    const scores = tokens.map((token) => tokenScore(token, "chunk"));
    const rank = sql<number>`${sql.join(
      scores.map((score) => sql`max(${score})`),
      sql` + `,
    )} + CASE WHEN lower(chunk.title) = ${needle} THEN 10 ELSE 0 END + CASE WHEN lower(doc.id) = ${needle} THEN 20 ELSE 0 END`;
    const accessible = [...effectiveWikiRoles(this.db)]
      .filter(([, members]) => members.has(params.userId))
      .map(([id]) => id);
    if (!accessible.length) {
      return [];
    }
    let query = this.query
      .selectFrom("knowledge_vault_chunks as chunk")
      .innerJoin("knowledge_vault_documents as doc", "doc.id", "chunk.document_id")
      .innerJoin("knowledge_vaults as vault", "vault.id", "doc.vault_id")
      .select([
        "vault.id as vault_id",
        "vault.name",
        "doc.id",
        "doc.logical_path",
        "doc.compile_status",
        "doc.compile_error",
        "doc.retry_at",
        "chunk.title",
        "chunk.revision",
      ])
      .select(rank.as("rank"))
      .select((eb) =>
        eb
          .selectFrom("knowledge_vault_chunks as candidate")
          .select("candidate.content")
          .whereRef("candidate.document_id", "=", "doc.id")
          .orderBy(
            sql<number>`${sql.join(
              tokens.map(
                (token) =>
                  sql`CASE WHEN lower(candidate.content) LIKE ${`%${token.replaceAll("_", "\\_")}%`} ESCAPE '\\' THEN 1 ELSE 0 END`,
              ),
              sql` + `,
            )}`,
            "desc",
          )
          .orderBy("candidate.ordinal")
          .limit(1)
          .as("content"),
      )
      .where("vault.id", "in", accessible);
    if (params.vaultId) {
      query = query.where("vault.id", "=", params.vaultId);
    } else if (params.vaultIds !== undefined) {
      if (params.vaultIds.length === 0) {
        return [];
      }
      query = query.where("vault.id", "in", params.vaultIds);
    }
    const rows = executeSync(
      this.db,
      // Group before limiting: a large document must not consume all result slots with its chunks.
      query
        .groupBy([
          "vault.id",
          "vault.name",
          "doc.id",
          "doc.logical_path",
          "doc.compile_status",
          "doc.compile_error",
          "doc.retry_at",
          "chunk.title",
          "chunk.revision",
        ])
        .having(
          sql<boolean>`${sql.join(
            scores.map((score) => sql`max(${score}) > 0`),
            sql` AND `,
          )}`,
        )
        .orderBy("rank", "desc")
        .orderBy("vault.id")
        .orderBy("doc.id")
        .limit(Math.max(1, Math.min(50, params.maxResults ?? 10))),
    ).rows;
    return rows.map((row) => {
      const content = row.content ?? "";
      const positions = tokens
        .map((token) => content.toLowerCase().indexOf(token))
        .filter((position) => position >= 0);
      const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 100);
      const hit: KnowledgeSearchHit = {
        vaultId: row.vault_id,
        vaultName: row.name,
        vaultType: "shared" as const,
        documentId: row.id,
        title: row.title,
        path: `shared/${row.vault_id}/${row.id}`,
        logicalPath: row.logical_path,
        link: formatWikiDocumentLink(row.logical_path, row.title),
        snippet: content.slice(start, start + 480),
        revision: row.revision,
        score: row.rank / (tokens.length * 15 + 30),
      };
      if (row.compile_status === "failed") {
        hit.indexStatus = "failed";
        if (row.compile_error !== null) {
          hit.indexError = row.compile_error;
        }
        if (row.retry_at !== null) {
          hit.nextRetryAt = row.retry_at;
        }
      }
      return hit;
    });
  }

  uploadAttachment(params: {
    userId: string;
    vaultId: string;
    path: string;
    mediaType: string;
    content: Buffer;
    expectedRevision?: number;
  }): void {
    this.access(params.userId, params.vaultId, "edit");
    const attachmentPath = knowledgeVaultPath(params.path);
    if (params.content.length > KNOWLEDGE_VAULT_LIMITS.attachmentBytes) {
      throw new ControlPlaneStateError("Attachment exceeds 8 MiB");
    }
    const mediaType = requireKnowledgeVaultMediaType(params.mediaType);
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId, "edit");
      const prior = takeFirstSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_attachments")
          .select(["revision", sql<number>`length(content)`.as("bytes")])
          .where("vault_id", "=", params.vaultId)
          .where("path", "=", attachmentPath),
      );
      if (prior && prior.revision !== params.expectedRevision) {
        throw new ControlPlaneConflictError(
          "knowledge_vault_changed",
          "Attachment changed; reload before replacing",
        );
      }
      this.requireCapacity(
        params.vaultId,
        params.content.length - (prior?.bytes ?? 0),
        prior ? 0 : 1,
      );
      const values = {
        media_type: mediaType,
        content: params.content,
        revision: (prior?.revision ?? 0) + 1,
      };
      executeSync(
        this.db,
        this.query
          .insertInto("knowledge_vault_attachments")
          .values({ ...values, vault_id: params.vaultId, path: attachmentPath })
          .onConflict((oc) => oc.columns(["vault_id", "path"]).doUpdateSet(values)),
      );
    });
  }

  downloadAttachment(params: { userId: string; vaultId: string; path: string }): {
    content: Buffer;
    mediaType: string;
    revision: number;
  } {
    this.access(params.userId, params.vaultId);
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("knowledge_vault_attachments")
        .selectAll()
        .where("vault_id", "=", params.vaultId)
        .where("path", "=", params.path),
    );
    if (!row) {
      throw new ControlPlaneNotFoundError("knowledge-vault-attachment", params.path);
    }
    return { content: Buffer.from(row.content), mediaType: row.media_type, revision: row.revision };
  }

  requireExport(userId: string, vaultId: string): void {
    this.access(userId, vaultId, "export");
  }

  async exportVault(params: { userId: string; vaultId: string }): Promise<Buffer> {
    this.requireExport(params.userId, params.vaultId);
    const data = runReadTransaction(this.db, () => {
      const vault = this.access(params.userId, params.vaultId, "export");
      const documents = executeSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_documents")
          .select(["title", "logical_path", "content"])
          .where("vault_id", "=", vault.id)
          .orderBy("logical_path"),
      ).rows.map((row) => ({
        title: row.title,
        logicalPath: row.logical_path,
        content: row.content,
      }));
      const attachments = executeSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_attachments")
          .selectAll()
          .where("vault_id", "=", vault.id)
          .orderBy("path"),
      ).rows.map((row) => ({
        path: row.path,
        mediaType: row.media_type,
        content: Buffer.from(row.content),
      }));
      return { name: vault.name, description: vault.description, documents, attachments };
    });
    const archive = await encodeKnowledgeVaultArchive(data);
    // ZIP generation yields; a revoked export grant must not release the prepared bytes.
    this.requireExport(params.userId, params.vaultId);
    return archive;
  }

  async importVault(params: {
    userId: string;
    archive: Buffer;
    name?: string;
  }): Promise<KnowledgeVault> {
    this.activeUser(params.userId);
    const data = await decodeKnowledgeVaultArchive(params.archive);
    const name = requireKnowledgeVaultText(params.name ?? data.name, "Vault name", 160);
    const vaultId = randomUUID();
    const now = Date.now();
    const documents = data.documents.map((document) => ({ ...document, id: randomUUID() }));
    // Validate/decompress first. The new Vault and every original appear atomically; no partial imports.
    runImmediateTransaction(this.db, () => {
      this.activeUser(params.userId);
      executeSync(
        this.db,
        this.query.insertInto("knowledge_vaults").values({
          id: vaultId,
          name,
          description: data.description,
          created_at: now,
          updated_at: now,
        }),
      );
      executeSync(
        this.db,
        this.query.insertInto("knowledge_vault_members").values({
          vault_id: vaultId,
          user_id: params.userId,
          role: "owner",
          can_export: 1,
        }),
      );
      reconcileWikiAccess(this.db);
      for (const doc of documents) {
        executeSync(
          this.db,
          this.query.insertInto("knowledge_vault_documents").values({
            id: doc.id,
            vault_id: vaultId,
            title: doc.title,
            logical_path: doc.logicalPath,
            content: doc.content,
            revision: 1,
            updated_at: now,
            compile_status: "pending",
            indexed_revision: null,
            compile_error: null,
            compile_attempts: 0,
            retry_at: now,
          }),
        );
      }
      for (const file of data.attachments) {
        executeSync(
          this.db,
          this.query.insertInto("knowledge_vault_attachments").values({
            vault_id: vaultId,
            path: file.path,
            media_type: file.mediaType,
            content: file.content,
            revision: 1,
          }),
        );
      }
    });
    for (const doc of documents) {
      this.compileDocument(doc.id);
    }
    return this.access(params.userId, vaultId);
  }
}
