import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { BrowserGatewayProxyError, type BrowserGatewayRpc } from "./browser-gateway-contracts.js";
import {
  personalWikiPagePath,
  projectWikiDocumentResult,
  WIKI_CONTENT_HASH,
} from "./browser-gateway-wiki-document.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
} from "./contracts.js";
import { knowledgeVaultPath } from "./knowledge-vault-compiler.js";
import {
  KNOWLEDGE_VAULT_LIMITS,
  type KnowledgeVaultDocument,
  type KnowledgeVaultDocumentPublishInput,
  type KnowledgeVaultDocumentPublishResult,
} from "./knowledge-vault-contracts.js";
import type { SqliteKnowledgeVaultStore } from "./sqlite-knowledge-vault-store.js";

export async function readPersonalPublicationSource(
  gateway: BrowserGatewayRpc,
  params: { agentId: string; lookup: string; expectedRevision: string },
  accountBytes?: (content: string) => void,
): Promise<{ title: string; content: string }> {
  const fail = (message: string): never => {
    throw new BrowserGatewayProxyError("upstream-result-denied", message);
  };
  const lookup = personalWikiPagePath(params.lookup, (message) => {
    throw new ControlPlaneStateError(message);
  });
  const request = { agentId: params.agentId, lookup };
  const document = projectWikiDocumentResult({
    method: "wiki.document.get",
    request,
    result: await gateway.request("wiki.document.get", request),
    agentId: params.agentId,
    fail,
  });
  if (
    !isRecord(document) ||
    typeof document.sourceContent !== "string" ||
    document.path !== lookup
  ) {
    throw new ControlPlaneNotFoundError("knowledge-vault-document", lookup);
  }
  accountBytes?.(document.sourceContent);
  if (
    createHash("sha256").update(document.sourceContent).digest("hex") !== params.expectedRevision
  ) {
    throw new ControlPlaneConflictError(
      "knowledge_vault_changed",
      "Personal document changed; reload and review before publishing",
    );
  }
  return { title: String(document.title), content: document.sourceContent };
}

export async function publishKnowledgeVaultDocuments(
  store: SqliteKnowledgeVaultStore,
  gateway: BrowserGatewayRpc,
  params: KnowledgeVaultDocumentPublishInput,
): Promise<KnowledgeVaultDocumentPublishResult> {
  const agentId = store.personalAgentForUser(params.userId);
  if (params.vaultId !== `personal:${agentId}`) {
    throw new ControlPlaneAuthorizationError("Publication requires your own Personal Wiki");
  }
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(params.publishId) ||
    params.documents.length === 0 ||
    params.documents.length > KNOWLEDGE_VAULT_LIMITS.publishDocuments ||
    new Set(params.documents.map((document) => document.documentId)).size !==
      params.documents.length ||
    params.documents.some((document) => !WIKI_CONTENT_HASH.test(document.expectedRevision))
  ) {
    throw new ControlPlaneStateError(
      "Use a valid publication identifier and 1-100 distinct revision-pinned documents",
    );
  }
  const rootPath = `imports/${params.publishId}`;
  const documents: KnowledgeVaultDocumentPublishResult["documents"] = [];
  let bytes = 0;
  const accountBytes = (content: string) => {
    const size = Buffer.byteLength(content);
    bytes += size;
    if (
      size > KNOWLEDGE_VAULT_LIMITS.documentBytes ||
      bytes > KNOWLEDGE_VAULT_LIMITS.publishBytes
    ) {
      throw new ControlPlaneStateError("Publication exceeds 1 MiB per document or 4 MiB per batch");
    }
  };
  const success = (
    sourceDocumentId: string,
    status: "published" | "unchanged",
    document: KnowledgeVaultDocument,
  ) => ({
    sourceDocumentId,
    status,
    documentId: document.id,
    logicalPath: document.logicalPath,
    revision: Number(document.revision),
    compile: document.compile,
  });
  for (const source of params.documents) {
    try {
      if (bytes > KNOWLEDGE_VAULT_LIMITS.publishBytes) {
        throw new ControlPlaneStateError("Publication batch exceeds 4 MiB");
      }
      const sourceDocumentId = personalWikiPagePath(source.documentId, (message) => {
        throw new ControlPlaneStateError(message);
      });
      const publication = {
        userId: params.userId,
        publishId: params.publishId,
        sourceVaultId: params.vaultId,
        sourceDocumentId,
        expectedRevision: source.expectedRevision,
        targetVaultId: params.targetVaultId,
        logicalPath: knowledgeVaultPath(`${rootPath}/${sourceDocumentId}`),
      };
      // Reconcile the original reviewed copy before fetching a possibly changed/deleted source.
      const prior = store.publishedDocument(publication);
      if (prior) {
        accountBytes(prior.content);
        documents.push(success(sourceDocumentId, "unchanged", prior));
        continue;
      }
      const document = await readPersonalPublicationSource(
        gateway,
        { agentId, lookup: sourceDocumentId, expectedRevision: source.expectedRevision },
        accountBytes,
      );
      // No await after the final source fetch. The write transaction rechecks both bindings/ACLs.
      const saved = store.publishDocument({ ...publication, ...document });
      documents.push(success(sourceDocumentId, saved.status, saved.document));
    } catch (error) {
      documents.push({
        sourceDocumentId: source.documentId,
        status: "failed",
        error:
          error instanceof ControlPlaneConflictError
            ? "conflict"
            : error instanceof ControlPlaneAuthorizationError
              ? "forbidden"
              : error instanceof ControlPlaneStateError
                ? "invalid"
                : "unavailable",
      });
    }
  }
  return { publishId: params.publishId, targetVaultId: params.targetVaultId, rootPath, documents };
}
