import { sql } from "kysely";
import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
} from "./contracts.js";
import { recordWikiAudit } from "./knowledge-vault-access.js";
import { requireKnowledgeVaultMediaType } from "./knowledge-vault-archive.js";
import { knowledgeVaultPath } from "./knowledge-vault-compiler.js";
import { KNOWLEDGE_VAULT_LIMITS } from "./knowledge-vault-contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { SqliteKnowledgeVaultSharingStore } from "./sqlite-knowledge-vault-sharing.js";

export abstract class SqliteKnowledgeVaultAttachmentStore extends SqliteKnowledgeVaultSharingStore {
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
      if (params.expectedRevision !== undefined && !prior) {
        throw new ControlPlaneConflictError(
          "knowledge_vault_changed",
          "Attachment changed; reload before replacing",
        );
      }
      if (prior && prior.revision !== params.expectedRevision) {
        throw new ControlPlaneConflictError(
          "knowledge_vault_changed",
          "Attachment changed; reload before replacing",
        );
      }
      const generation = takeFirstSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_attachment_revisions")
          .select("revision")
          .where("vault_id", "=", params.vaultId)
          .where("path", "=", attachmentPath),
      );
      this.requireCapacity(
        params.vaultId,
        params.content.length - (prior?.bytes ?? 0),
        prior ? 0 : 1,
      );
      const values = {
        media_type: mediaType,
        content: params.content,
        revision: Math.max(generation?.revision ?? 0, prior?.revision ?? 0) + 1,
      };
      executeSync(
        this.db,
        this.query
          .insertInto("knowledge_vault_attachments")
          .values({ ...values, vault_id: params.vaultId, path: attachmentPath })
          .onConflict((oc) => oc.columns(["vault_id", "path"]).doUpdateSet(values)),
      );
      executeSync(
        this.db,
        this.query
          .insertInto("knowledge_vault_attachment_revisions")
          .values({ vault_id: params.vaultId, path: attachmentPath, revision: values.revision })
          .onConflict((oc) =>
            oc.columns(["vault_id", "path"]).doUpdateSet({ revision: values.revision }),
          ),
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

  deleteAttachment(params: {
    userId: string;
    vaultId: string;
    path: string;
    expectedRevision: number;
  }): { deleted: true; path: string } {
    this.access(params.userId, params.vaultId, "edit");
    const attachmentPath = knowledgeVaultPath(params.path);
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId, "edit");
      const prior = takeFirstSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_attachments")
          .select("revision")
          .where("vault_id", "=", params.vaultId)
          .where("path", "=", attachmentPath),
      );
      if (!prior) {
        throw new ControlPlaneNotFoundError("knowledge-vault-attachment", attachmentPath);
      }
      if (prior.revision !== params.expectedRevision) {
        throw new ControlPlaneConflictError(
          "knowledge_vault_changed",
          "Attachment changed; reload before deleting",
        );
      }
      executeSync(
        this.db,
        this.query
          .deleteFrom("knowledge_vault_attachments")
          .where("vault_id", "=", params.vaultId)
          .where("path", "=", attachmentPath),
      );
      recordWikiAudit(this.db, params.userId, "wiki.attachment.deleted", params.vaultId, {
        path: attachmentPath,
        revision: prior.revision,
      });
    });
    return { deleted: true, path: attachmentPath };
  }
}
