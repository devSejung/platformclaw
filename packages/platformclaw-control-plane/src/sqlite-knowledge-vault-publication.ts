import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ControlPlaneConflictError } from "./contracts.js";
import { createSyncKysely, executeSync, takeFirstSync } from "./kysely-sync.js";
import type { KnowledgeVaultDatabase } from "./sqlite-schema-knowledge-vault.js";

export type KnowledgeVaultPublication = {
  userId: string;
  publishId: string;
  sourceVaultId: string;
  sourceDocumentId: string;
  expectedRevision: string;
  targetVaultId: string;
  logicalPath: string;
};

const query = createSyncKysely<KnowledgeVaultDatabase>();

/** The caller owns the live access check and transaction, including on replay. */
export function findKnowledgeVaultPublication(
  db: DatabaseSync,
  params: KnowledgeVaultPublication,
): string | undefined {
  const receipt = takeFirstSync(
    db,
    query
      .selectFrom("knowledge_vault_document_publications")
      .selectAll()
      .where("user_id", "=", params.userId)
      .where("publish_id", "=", params.publishId)
      .where("source_document_id", "=", params.sourceDocumentId),
  );
  if (!receipt) {
    return undefined;
  }
  const document = takeFirstSync(
    db,
    query
      .selectFrom("knowledge_vault_documents")
      .selectAll()
      .where("id", "=", receipt.target_document_id)
      .where("vault_id", "=", receipt.target_vault_id),
  );
  // Receipts deliberately outlive deleted documents. An uncertain retry must neither
  // resurrect a removed copy nor overwrite a later edit, move, or path replacement.
  if (
    receipt.source_vault_id !== params.sourceVaultId ||
    receipt.source_revision !== params.expectedRevision ||
    receipt.target_vault_id !== params.targetVaultId ||
    receipt.target_path !== params.logicalPath ||
    !document ||
    document.revision !== 1 ||
    document.logical_path !== receipt.target_path ||
    createHash("sha256").update(document.content).digest("hex") !== receipt.source_revision
  ) {
    throw new ControlPlaneConflictError(
      "knowledge_vault_changed",
      "The reviewed publication or its Shared copy changed; review a new publication",
    );
  }
  return document.id;
}

/** Insert alongside the original, never in a later transaction or a source-side sidecar. */
export function recordKnowledgeVaultPublication(
  db: DatabaseSync,
  params: KnowledgeVaultPublication,
  documentId: string,
): void {
  executeSync(
    db,
    query.insertInto("knowledge_vault_document_publications").values({
      user_id: params.userId,
      publish_id: params.publishId,
      source_vault_id: params.sourceVaultId,
      source_document_id: params.sourceDocumentId,
      source_revision: params.expectedRevision,
      target_vault_id: params.targetVaultId,
      target_document_id: documentId,
      target_path: params.logicalPath,
    }),
  );
}
