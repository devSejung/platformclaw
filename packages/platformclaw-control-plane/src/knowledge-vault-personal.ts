import { createHash } from "node:crypto";
import { formatWikiDocumentLink } from "@openclaw/markdown-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { wikiPath } from "./browser-gateway-content-paths.js";
import { BrowserGatewayProxyError, type BrowserGatewayRpc } from "./browser-gateway-contracts.js";
import { personalWikiPagePath, WIKI_CONTENT_HASH } from "./browser-gateway-wiki-document.js";
import { projectBrowserWikiResult } from "./browser-gateway-wiki.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import type {
  KnowledgeVault,
  KnowledgeVaultCatalogEntry,
  KnowledgeVaultCompile,
  KnowledgeVaultDocument,
  KnowledgeVaultDocumentInput,
  KnowledgeVaultDocumentImportInput,
  KnowledgeVaultDocumentImportResult,
  KnowledgeVaultSnapshot,
} from "./knowledge-vault-contracts.js";
import { KNOWLEDGE_VAULT_LIMITS } from "./knowledge-vault-contracts.js";
import { resolveKnowledgeVaultDocumentMetadata } from "./knowledge-vault-document.js";
import { PersonalKnowledgeFiles } from "./knowledge-vault-personal-files.js";
import type { SqliteKnowledgeVaultStore } from "./sqlite-knowledge-vault-store.js";

const fail = (message: string): never => {
  throw new BrowserGatewayProxyError("upstream-result-denied", message);
};
const record = (value: unknown) => (isRecord(value) ? value : fail("Invalid Personal Wiki result"));
const objects = (value: unknown) =>
  Array.isArray(value) ? value.map(record) : fail("Invalid Personal Wiki list");
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 100)
    : [];
const timestamp = (value: unknown) => (typeof value === "string" ? Date.parse(value) || 0 : 0);

/** Maps the existing private Wiki owner to the common UI; identity is always server-bound. */
export class PersonalKnowledgeVault {
  constructor(
    private readonly store: SqliteKnowledgeVaultStore,
    private readonly gateway: BrowserGatewayRpc,
  ) {}
  private readonly files = new PersonalKnowledgeFiles(this.gateway);
  private agent(userId: string, vaultId?: string) {
    const agentId = this.store.personalAgentForUser(userId);
    if (vaultId !== undefined && vaultId !== `personal:${agentId}`) {
      throw new ControlPlaneAuthorizationError("Personal Wiki is unavailable");
    }
    return agentId;
  }
  catalog(userId: string): KnowledgeVaultCatalogEntry {
    const agentId = this.agent(userId);
    return {
      id: `personal:${agentId}`,
      name: "Personal Wiki",
      description: "Private knowledge",
      type: "personal",
      role: "owner",
      canRead: true,
      canEdit: true,
      canManageMembers: false,
      canExport: true,
      connected: this.store.connectionScope(userId).personalEnabled,
      createdAt: 0,
      updatedAt: 0,
    };
  }
  private async request(agentId: string, method: string, fields: Record<string, unknown> = {}) {
    const request = { ...fields, agentId };
    const result = await this.gateway.request(method, request);
    return projectBrowserWikiResult({ method, request, result, agentId, fail });
  }
  async selected(
    userId: string,
    vaultId: string,
  ): Promise<NonNullable<KnowledgeVaultSnapshot["selected"]>> {
    const agentId = this.agent(userId, vaultId);
    const [overviewResult, graphResult, manifest] = await Promise.all([
      this.request(agentId, "wiki.overview"),
      this.request(agentId, "wiki.graph"),
      this.files.manifest(agentId, "attachment"),
    ]);
    const overview = record(overviewResult);
    const graph = record(graphResult);
    const items = objects(overview.documents);
    const failure = isRecord(overview.compileFailure) ? overview.compileFailure : undefined;
    const compile: KnowledgeVaultCompile = {
      status: failure ? "failed" : "ready",
      indexedRevision: null,
      error: failure ? String(failure.error) : null,
      attempts: failure ? Number(failure.attempts) : 0,
      retryAt: failure ? Number(failure.nextRetryAt) : null,
    };
    const documents = items.map((item) => {
      const updatedAt = item.updatedAt;
      return {
        id: String(item.pagePath),
        vaultId,
        title: String(item.title),
        snippet: typeof item.snippet === "string" ? item.snippet.slice(0, 240) : "",
        link: formatWikiDocumentLink(String(item.pagePath), String(item.title)),
        logicalPath: String(item.pagePath),
        revision: typeof updatedAt === "string" ? updatedAt : "",
        updatedAt: timestamp(updatedAt),
        compile,
        metadata: {
          claims: strings(item.claims),
          questions: strings(item.questions),
          contradictions: strings(item.contradictions),
          kind: String(item.kind),
          ...(typeof item.sourceType === "string" ? { sourceType: item.sourceType } : {}),
        },
      };
    });
    const catalogEntry = this.catalog(userId);
    const vault: KnowledgeVault = { ...catalogEntry, role: "owner" };
    const stats = record(graph.stats);
    const documentIds = new Set(documents.map((document) => document.id));
    return {
      vault,
      documents,
      documentCount: Number(overview.totalPages),
      documentsTruncated: overview.documentsTruncated === true,
      members: [],
      grants: [],
      attachmentsTruncated: manifest.truncated,
      attachments: manifest.entries
        .filter((entry) => entry.kind === "attachment")
        .map((entry) => ({
          path: entry.path,
          mediaType: entry.mediaType ?? "application/octet-stream",
          bytes: entry.size,
          revision: entry.revision,
        })),
      graph: {
        nodeIds: objects(graph.nodes)
          .map((node) => String(node.id))
          .filter((id) => documentIds.has(id)),
        edges: objects(graph.edges)
          .filter(
            (edge) => documentIds.has(String(edge.source)) && documentIds.has(String(edge.target)),
          )
          .map((edge) => ({ source: String(edge.source), target: String(edge.target) })),
        unresolvedLinks: Number(stats.unresolvedLinks),
        truncated: stats.truncated === true,
      },
    };
  }
  async read(params: {
    userId: string;
    vaultId: string;
    documentId: string;
  }): Promise<KnowledgeVaultDocument> {
    const agentId = this.agent(params.userId, params.vaultId);
    const lookup = wikiPath(params.documentId, "Personal document", fail);
    const document = record(await this.request(agentId, "wiki.document.get", { lookup }));
    if (document.path !== lookup) {
      return fail("Personal Wiki returned another document");
    }
    const source = String(document.sourceContent);
    const selected = await this.selected(params.userId, params.vaultId);
    const summary = selected.documents.find((item) => item.id === lookup);
    const links = objects(document.links).map((link) => ({
      target: String(link.target),
      documentId:
        link.documentId === null || typeof link.documentId === "string"
          ? link.documentId
          : fail("Invalid Personal Wiki link document"),
      logicalPath: String(link.logicalPath),
      title: String(link.title),
    }));
    const backlinks = selected.graph.edges
      .filter((edge) => edge.target === lookup)
      .map((edge) => ({
        target: edge.source,
        documentId: edge.source,
        logicalPath: edge.source,
        title: selected.documents.find((item) => item.id === edge.source)?.title ?? edge.source,
      }));
    // Revision is the original source hash even for a generated/read-only page.
    return {
      id: lookup,
      vaultId: params.vaultId,
      logicalPath: lookup,
      link: formatWikiDocumentLink(lookup, String(document.title)),
      title: String(document.title),
      snippet: summary?.snippet ?? "",
      revision:
        typeof document.revision === "string" && WIKI_CONTENT_HASH.test(document.revision)
          ? document.revision
          : fail("Personal Wiki returned no source revision"),
      updatedAt: timestamp(document.updatedAt),
      compile: summary?.compile ?? {
        status: "ready",
        indexedRevision: null,
        error: null,
        attempts: 0,
        retryAt: null,
      },
      content: String(document.displayContent),
      sourceContent: source,
      ...(typeof document.editableContent === "string"
        ? { editableContent: document.editableContent }
        : {}),
      editMode:
        document.editMode === "body" || document.editMode === "notes" ? document.editMode : null,
      ...(typeof document.canDelete === "boolean" ? { canDelete: document.canDelete } : {}),
      ...(typeof document.readOnlyReason === "string"
        ? { readOnlyReason: document.readOnlyReason }
        : {}),
      metadata: {
        ...(summary?.metadata ?? { claims: [], questions: [], contradictions: [] }),
        kind: String(document.kind),
        ...(typeof document.sourceType === "string" ? { sourceType: document.sourceType } : {}),
      },
      links,
      linksTruncated: document.linksTruncated === true,
      backlinks,
    };
  }
  preview(params: KnowledgeVaultDocumentInput) {
    this.agent(params.userId, params.vaultId);
    if (params.logicalPath !== undefined) {
      throw new ControlPlaneStateError("Personal Wiki assigns the path automatically");
    }
    return { ...resolveKnowledgeVaultDocumentMetadata(params), logicalPath: "" };
  }
  async importDocuments(
    params: KnowledgeVaultDocumentImportInput,
  ): Promise<KnowledgeVaultDocumentImportResult> {
    const agentId = this.agent(params.userId, params.vaultId);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(params.importId) ||
      params.documents.length === 0 ||
      params.documents.length > KNOWLEDGE_VAULT_LIMITS.importDocuments
    ) {
      throw new ControlPlaneStateError("Use a valid upload identifier and at most 100 documents");
    }
    let bytes = 0;
    for (const document of params.documents) {
      const documentBytes = Buffer.byteLength(document.content);
      bytes += documentBytes;
      if (documentBytes > KNOWLEDGE_VAULT_LIMITS.documentBytes) {
        throw new ControlPlaneStateError("Document exceeds 1 MiB");
      }
    }
    if (bytes > KNOWLEDGE_VAULT_LIMITS.importBytes) {
      throw new ControlPlaneStateError("Upload batch exceeds 4 MiB");
    }
    const rootPath = `concepts/imports/${params.importId}`;
    const result = record(
      await this.gateway.request("wiki.document.import", {
        agentId,
        importId: params.importId,
        documents: params.documents,
      }),
    );
    const outcomes = objects(result.documents);
    if (
      result.importId !== params.importId ||
      result.rootPath !== rootPath ||
      typeof result.indexesRefreshed !== "boolean" ||
      outcomes.length !== params.documents.length
    ) {
      return fail("Personal Wiki did not confirm the complete upload outcome");
    }
    const documents: KnowledgeVaultDocumentImportResult["documents"] = outcomes.map(
      (outcome, index) => {
        const source = params.documents[index]!;
        const relativePath = source.relativePath;
        const path = `${rootPath}/${relativePath.normalize("NFC").replace(/\.(?:md|markdown)$/iu, ".md")}`;
        if (outcome.relativePath !== relativePath || outcome.path !== path) {
          return fail("Personal Wiki returned an unrelated upload document");
        }
        personalWikiPagePath(path, fail);
        if (outcome.status === "failed") {
          if (
            outcome.error !== "conflict" &&
            outcome.error !== "unavailable" &&
            outcome.error !== "invalid"
          ) {
            return fail("Personal Wiki returned an invalid upload failure");
          }
          return { relativePath, path, status: "failed", error: outcome.error };
        }
        if (
          (outcome.status !== "saved" && outcome.status !== "unchanged") ||
          typeof outcome.title !== "string" ||
          !outcome.title.trim() ||
          outcome.title.length > 240 ||
          typeof outcome.revision !== "string" ||
          outcome.revision !== createHash("sha256").update(source.content).digest("hex")
        ) {
          return fail("Personal Wiki did not confirm the original uploaded source");
        }
        return {
          relativePath,
          path,
          status: outcome.status,
          title: outcome.title,
          revision: outcome.revision,
        };
      },
    );
    return {
      importId: params.importId,
      rootPath,
      documents,
      indexesRefreshed: result.indexesRefreshed,
    };
  }
  async save(params: KnowledgeVaultDocumentInput): Promise<KnowledgeVaultDocument> {
    const agentId = this.agent(params.userId, params.vaultId);
    this.preview({ ...params, logicalPath: undefined });
    if (!params.documentId) {
      if (params.logicalPath !== undefined) {
        throw new ControlPlaneStateError("Personal Wiki assigns the path automatically");
      }
      const { title } = resolveKnowledgeVaultDocumentMetadata(params);
      const result = record(
        await this.gateway.request("wiki.document.create", {
          agentId,
          title,
          content: params.content,
          ...(params.filename === undefined ? {} : { filename: params.filename }),
        }),
      );
      const path = personalWikiPagePath(result.path, fail);
      if (
        result.saved !== true ||
        typeof result.revision !== "string" ||
        !WIKI_CONTENT_HASH.test(result.revision)
      ) {
        return fail("Personal Wiki create did not confirm the saved document");
      }
      return this.read({ ...params, documentId: path });
    }
    const prior = await this.read({ ...params, documentId: params.documentId });
    if (prior.revision !== params.expectedRevision) {
      throw new ControlPlaneConflictError(
        "knowledge_vault_changed",
        "Personal document changed; reload before saving",
      );
    }
    if (!prior.editMode) {
      throw new ControlPlaneStateError(prior.readOnlyReason ?? "Document is read-only");
    }
    // The underlying source owner checks the same hash under its write lock.
    this.agent(params.userId, params.vaultId);
    const result = record(
      await this.request(agentId, "wiki.document.save", {
        path: personalWikiPagePath(params.documentId, fail),
        editMode: prior.editMode,
        content: params.content,
        expectedRevision: params.expectedRevision,
        ...(params.title === undefined ? {} : { title: params.title }),
      }),
    );
    // The source owner returns saved:false for an unchanged body; it is a successful no-op.
    if (typeof result.saved !== "boolean") {
      return fail("Personal document save returned no outcome");
    }
    return this.read({ ...params, documentId: params.documentId });
  }
  requireExport(userId: string, vaultId: string): void {
    this.agent(userId, vaultId);
  }
  export(userId: string, vaultId: string) {
    return this.files.export(this.agent(userId, vaultId));
  }
  download(params: { userId: string; vaultId: string; path: string }) {
    return this.files.download(this.agent(params.userId, params.vaultId), params.path);
  }
  upload(params: {
    userId: string;
    vaultId: string;
    path: string;
    content: Buffer;
    expectedRevision?: number | string;
  }) {
    return this.files.upload(this.agent(params.userId, params.vaultId), params);
  }
  deleteAttachment(params: {
    userId: string;
    vaultId: string;
    path: string;
    expectedRevision: number | string;
  }) {
    if (typeof params.expectedRevision !== "string") {
      throw new ControlPlaneStateError("Reload the attachment before deleting it");
    }
    return this.files.delete(this.agent(params.userId, params.vaultId), {
      path: params.path,
      expectedRevision: params.expectedRevision,
    });
  }
  async delete(params: {
    userId: string;
    vaultId: string;
    documentId: string;
    expectedRevision: number | string;
  }) {
    const agentId = this.agent(params.userId, params.vaultId);
    if (
      typeof params.expectedRevision !== "string" ||
      !WIKI_CONTENT_HASH.test(params.expectedRevision)
    ) {
      throw new ControlPlaneStateError("Read the Personal document before deleting");
    }
    const result = record(
      await this.request(agentId, "wiki.delete", {
        path: personalWikiPagePath(params.documentId, fail),
        expectedContentHash: params.expectedRevision,
      }),
    );
    return {
      deleted: true,
      documentId: params.documentId,
      indexesRefreshed: result.indexesRefreshed === true,
    };
  }
  async rebuild(userId: string, vaultId: string) {
    const agentId = this.agent(userId, vaultId);
    await this.gateway.request("wiki.compile", { agentId });
    return this.selected(userId, vaultId);
  }
}
