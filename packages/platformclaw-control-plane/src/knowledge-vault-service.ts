import { createHash } from "node:crypto";
import { formatWikiDocumentLink } from "@openclaw/markdown-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { BrowserGatewayProxyError, type BrowserGatewayRpc } from "./browser-gateway-contracts.js";
import {
  personalWikiPagePath,
  projectWikiDocumentResult,
} from "./browser-gateway-wiki-document.js";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import {
  KNOWLEDGE_VAULT_LIMITS,
  KnowledgeVaultSearchError,
  type KnowledgeSearchHit,
  type KnowledgeVaultTurnScope,
  type KnowledgeVaultSnapshot,
  type KnowledgeVaultDocumentInput,
  type KnowledgeVaultDocumentImportInput,
} from "./knowledge-vault-contracts.js";
import {
  operateSharedWiki,
  type KnowledgeVaultWikiOperation,
} from "./knowledge-vault-operations.js";
import { PersonalKnowledgeVault } from "./knowledge-vault-personal.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

/** Owns employee identity and corpus routing; callers never select a storage backend. */
export class KnowledgeVaultService {
  constructor(
    readonly store: SqliteControlPlaneStore,
    private readonly gateway: BrowserGatewayRpc,
  ) {}

  private readonly personal = new PersonalKnowledgeVault(this.store.vaults, this.gateway);

  async snapshot(params: { userId: string; vaultId?: string }): Promise<KnowledgeVaultSnapshot> {
    const personal = this.personal.catalog(params.userId);
    const shared = this.store.vaults.snapshot({
      userId: params.userId,
      ...(params.vaultId && !params.vaultId.startsWith("personal:")
        ? { vaultId: params.vaultId }
        : {}),
    });
    shared.vaults.unshift(personal);
    if (params.vaultId?.startsWith("personal:")) {
      shared.selected = await this.personal.selected(params.userId, params.vaultId);
      personal.documentCount = shared.selected.documentCount;
    }
    return shared;
  }

  async setConnection(params: { userId: string; vaultId: string; connected: boolean }) {
    if (params.vaultId.startsWith("personal:")) {
      if (params.vaultId !== this.personal.catalog(params.userId).id) {
        throw new ControlPlaneAuthorizationError("Personal Wiki is unavailable");
      }
      this.store.vaults.setPersonalEnabled(params.userId, params.connected);
    } else {
      this.store.vaults.setConnection(params);
    }
    return this.snapshot({ userId: params.userId, vaultId: params.vaultId });
  }

  requireExport(userId: string, vaultId: string): void {
    if (vaultId.startsWith("personal:")) {
      this.personal.requireExport(userId, vaultId);
    } else {
      this.store.vaults.requireExport(userId, vaultId);
    }
  }
  async exportVault(params: { userId: string; vaultId: string }) {
    this.requireExport(params.userId, params.vaultId);
    const archive = await (params.vaultId.startsWith("personal:")
      ? this.personal.export(params.userId, params.vaultId)
      : this.store.vaults.exportVault(params));
    this.requireExport(params.userId, params.vaultId);
    return archive;
  }
  async downloadAttachment(params: { userId: string; vaultId: string; path: string }) {
    if (!params.vaultId.startsWith("personal:")) {
      return this.store.vaults.downloadAttachment(params);
    }
    const file = await this.personal.download(params);
    this.personal.requireExport(params.userId, params.vaultId);
    return file;
  }
  async uploadAttachment(params: {
    userId: string;
    vaultId: string;
    path: string;
    content: Buffer;
    mediaType: string;
    expectedRevision?: number | string;
  }) {
    if (params.vaultId.startsWith("personal:")) {
      return this.personal.upload(params);
    }
    if (params.expectedRevision !== undefined && typeof params.expectedRevision !== "number") {
      throw new ControlPlaneStateError("Invalid Shared attachment revision");
    }
    return this.store.vaults.uploadAttachment({
      ...params,
      expectedRevision: params.expectedRevision,
    });
  }
  async deleteAttachment(params: {
    userId: string;
    vaultId: string;
    path: string;
    expectedRevision: number | string;
  }) {
    if (params.vaultId.startsWith("personal:")) {
      return this.personal.deleteAttachment(params);
    }
    if (typeof params.expectedRevision !== "number") {
      throw new ControlPlaneStateError("Invalid Shared attachment revision");
    }
    return this.store.vaults.deleteAttachment({
      ...params,
      expectedRevision: params.expectedRevision,
    });
  }
  readDocument(params: { userId: string; vaultId: string; documentId: string }) {
    return params.vaultId.startsWith("personal:")
      ? this.personal.read(params)
      : this.store.vaults.readDocument(params);
  }
  async documentTargets(params: { userId: string; vaultId: string; query: string }) {
    const selected = (await this.snapshot(params)).selected!;
    if (!selected.vault.canEdit) {
      throw new ControlPlaneAuthorizationError(
        "Editor permission required to insert a document link",
      );
    }
    const query = params.query.trim().toLowerCase();
    const matches = selected.documents
      .filter(
        (document) =>
          !query ||
          document.title.toLowerCase().includes(query) ||
          document.logicalPath.toLowerCase().includes(query),
      )
      .toSorted((left, right) => left.logicalPath.localeCompare(right.logicalPath));
    return {
      items: matches.slice(0, 20).map((document) => ({
        documentId: document.id,
        title: document.title,
        logicalPath: document.logicalPath,
        // Picker selections name an exact Personal document across import namespaces.
        link: formatWikiDocumentLink(document.logicalPath, document.title, {
          rooted: selected.vault.type === "personal",
        }),
      })),
      hasMore: matches.length > 20 || selected.documentsTruncated === true,
    };
  }
  deleteDocument(params: {
    userId: string;
    vaultId: string;
    documentId: string;
    expectedRevision: number | string;
  }) {
    return params.vaultId.startsWith("personal:")
      ? this.personal.delete(params)
      : this.store.vaults.deleteDocument(params);
  }
  previewDocument(params: KnowledgeVaultDocumentInput) {
    return params.vaultId.startsWith("personal:")
      ? this.personal.preview(params)
      : this.store.vaults.previewDocument(params);
  }
  saveDocument(params: KnowledgeVaultDocumentInput) {
    return params.vaultId.startsWith("personal:")
      ? this.personal.save(params)
      : this.store.vaults.saveDocument(params);
  }
  importDocuments(params: KnowledgeVaultDocumentImportInput) {
    if (!params.vaultId.startsWith("personal:")) {
      throw new ControlPlaneStateError("Batch document upload requires Personal Wiki");
    }
    return this.personal.importDocuments(params);
  }
  async rebuild(params: { userId: string; vaultId: string; documentId?: string }) {
    if (params.vaultId.startsWith("personal:")) {
      await this.personal.rebuild(params.userId, params.vaultId);
      return this.snapshot({ userId: params.userId, vaultId: params.vaultId });
    }
    return this.store.vaults.rebuild(params);
  }
  resolveSharedTarget(userId: string, vaultId?: string, vaultName?: string): string | undefined {
    if (vaultName === undefined) {
      return vaultId;
    }
    if (vaultId !== undefined || !vaultName.trim() || vaultName.length > 240) {
      throw new ControlPlaneStateError("Specify only vaultId or an exact vaultName");
    }
    const matches = this.store.vaults
      .listVaults(userId)
      .filter(
        (vault) =>
          vault.canRead && vault.name.trim().toLowerCase() === vaultName.trim().toLowerCase(),
      );
    if (matches.length !== 1) {
      throw new KnowledgeVaultSearchError(
        matches.length ? "vault-name-ambiguous" : "vault-name-not-found",
        matches.length
          ? "Multiple accessible Wikis have that name"
          : "No accessible Shared Wiki has that exact name",
        matches.length
          ? "Ask the user to choose a Wiki, then retry with vaultId."
          : "Check the name and request access in Wiki Hub.",
        matches
          .slice(0, 5)
          .map((vault) => ({ vaultId: vault.id, vaultName: vault.name, vaultType: vault.type })),
      );
    }
    return matches[0]!.id;
  }

  captureScope(params: { agentId: string }): KnowledgeVaultTurnScope {
    const userId = this.store.vaults.userIdForAgent(params.agentId);
    // Freeze only preferences for this run; each search checks current ACLs before querying.
    const selection = this.store.vaults.connectionScope(userId);
    const { vaultIds } = selection;
    if (
      vaultIds.length > KNOWLEDGE_VAULT_LIMITS.connections ||
      vaultIds.some((vaultId) => vaultId.length > 512)
    ) {
      throw new ControlPlaneStateError(
        "Connected Vault scope exceeds supported bounds; disconnect Vaults and retry",
      );
    }
    return selection;
  }

  async search(params: {
    agentId: string;
    query: string;
    vaultId?: string;
    vaultName?: string;
    maxResults?: number;
    scope?: "connected" | "all";
    turnScope?: KnowledgeVaultTurnScope;
  }): Promise<KnowledgeSearchHit[]> {
    const userId = this.store.vaults.userIdForAgent(params.agentId);
    const vaultId = this.resolveSharedTarget(userId, params.vaultId, params.vaultName);
    if (vaultId?.startsWith("personal:")) {
      return [];
    }
    const vaultIds =
      vaultId || params.scope === "all"
        ? undefined
        : (params.turnScope ?? this.store.vaults.connectionScope(userId)).vaultIds;
    return this.store.vaults.search({ ...params, userId, vaultId, vaultIds });
  }

  async get(params: { agentId: string; path: string; fromLine?: number; lineCount?: number }) {
    const userId = this.store.vaults.userIdForAgent(params.agentId);
    const match = /^shared\/([^/]+)\/([^/]+)$/u.exec(params.path);
    if (!match) {
      return null;
    }
    const document = this.store.vaults.readDocument({
      userId,
      vaultId: match[1]!,
      documentId: match[2]!,
    });
    const vault = this.store.vaults.snapshot({ userId, vaultId: match[1]! }).selected!.vault;
    const fromLine = params.fromLine ?? 1;
    const allLines = (document.editableContent ?? document.content).split(/\r?\n/u);
    const lines = allLines.slice(
      fromLine - 1,
      fromLine - 1 + Math.min(200, params.lineCount ?? 50),
    );
    let editableContent = "";
    let included = 0;
    for (const line of lines) {
      if (editableContent.length + line.length + 1 > 12_000) {
        break;
      }
      editableContent += (included ? "\n" : "") + line;
      included++;
    }
    const overlongLine = included === 0 && lines.length > 0;
    if (overlongLine) {
      editableContent = lines[0]!.slice(0, 12_000);
    }
    const truncated = overlongLine || fromLine > 1 || fromLine - 1 + included < allLines.length;
    return {
      vaultId: vault.id,
      vaultName: vault.name,
      vaultType: vault.type,
      documentId: document.id,
      revision: String(document.revision),
      title: document.title,
      path: params.path,
      logicalPath: document.logicalPath,
      link: formatWikiDocumentLink(document.logicalPath, document.title),
      content: editableContent,
      editableContent,
      editMode: overlongLine ? null : "body",
      fromLine,
      lineCount: included,
      totalLines: allLines.length,
      truncated,
      ...(!overlongLine && fromLine - 1 + included < allLines.length
        ? { nextFromLine: fromLine + included }
        : {}),
      ...(overlongLine ? { readOnlyReason: "page-too-large" } : {}),
      ...(truncated
        ? {
            action: overlongLine
              ? "This line exceeds the tool excerpt bound; open Wiki Hub to edit the complete body."
              : "Read the remaining body before replacing the whole document.",
          }
        : {}),
    };
  }

  wiki(params: KnowledgeVaultWikiOperation) {
    return operateSharedWiki(this, params);
  }

  async publish(params: {
    userId: string;
    agentId: string;
    lookup: string;
    targetVaultId: string;
    path?: string;
    expectedRevision: string;
    title?: string;
    content?: string;
  }) {
    if (this.store.vaults.personalAgentForUser(params.userId) !== params.agentId) {
      throw new ControlPlaneAuthorizationError("Personal Wiki is unavailable");
    }
    const target = this.store.vaults.snapshot({
      userId: params.userId,
      vaultId: params.targetVaultId,
    }).selected;
    if (!target?.vault.canEdit) {
      throw new ControlPlaneAuthorizationError(
        "Editor permission required in the destination vault",
      );
    }
    const fail = (message: string): never => {
      throw new BrowserGatewayProxyError("upstream-result-denied", message);
    };
    const lookup = personalWikiPagePath(params.lookup, fail);
    const request = { agentId: params.agentId, lookup };
    const raw = await this.gateway.request("wiki.document.get", request);
    const document = projectWikiDocumentResult({
      method: "wiki.document.get",
      request,
      result: raw,
      agentId: params.agentId,
      fail,
    });
    if (
      !isRecord(document) ||
      typeof document.sourceContent !== "string" ||
      document.path !== lookup
    ) {
      throw new ControlPlaneStateError("Personal document unavailable; reload before publishing");
    }
    // Publication is an explicit copy of the reviewed source, never a compiler side effect.
    const revision = createHash("sha256").update(document.sourceContent).digest("hex");
    if (revision !== params.expectedRevision) {
      throw new ControlPlaneStateError(
        "Personal document changed; reload and review before publishing",
      );
    }
    return this.store.vaults.saveDocument({
      userId: params.userId,
      vaultId: params.targetVaultId,
      title: params.title ?? String(document.title),
      logicalPath: params.path,
      content: params.content ?? document.sourceContent,
    });
  }
}
