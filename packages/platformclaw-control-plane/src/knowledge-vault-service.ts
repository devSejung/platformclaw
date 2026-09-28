import { createHash } from "node:crypto";
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
  mergeKnowledgeSearchHits,
  type KnowledgeSearchHit,
  type KnowledgeVaultTurnScope,
  type KnowledgeVaultSnapshot,
} from "./knowledge-vault-contracts.js";
import { managedKnowledgeVaultId } from "./sqlite-store-organization-memory.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

/** Owns the employee boundary across the shared store and existing managed read model. */
export class KnowledgeVaultService {
  constructor(
    readonly store: SqliteControlPlaneStore,
    private readonly gateway: BrowserGatewayRpc,
  ) {}

  snapshot(params: { userId: string; vaultId?: string }): KnowledgeVaultSnapshot {
    const shared = this.store.vaults.snapshot({
      userId: params.userId,
      ...(params.vaultId && !params.vaultId.startsWith("managed:")
        ? { vaultId: params.vaultId }
        : {}),
    });
    const connected = new Set(this.store.vaults.connectionScope(params.userId).vaultIds);
    const managed = this.store.listManagedKnowledgeVaults(params.userId);
    for (const vault of managed) {
      vault.connected = connected.has(vault.id);
    }
    shared.vaults.push(...managed);
    shared.vaults.sort(
      (left, right) =>
        left.type.localeCompare(right.type) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
    if (params.vaultId && !shared.vaults.some((vault) => vault.id === params.vaultId)) {
      throw new ControlPlaneAuthorizationError("Vault is unavailable");
    }
    return shared;
  }

  setConnection(params: {
    userId: string;
    vaultId: string;
    connected: boolean;
  }): KnowledgeVaultSnapshot {
    this.snapshot({ userId: params.userId, vaultId: params.vaultId });
    this.store.vaults.setConnection(params);
    return this.snapshot({ userId: params.userId, vaultId: params.vaultId });
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
    let vaultId = params.vaultId;
    if (params.vaultName !== undefined) {
      if (
        params.vaultId !== undefined ||
        !params.vaultName.trim() ||
        params.vaultName.length > 240
      ) {
        throw new ControlPlaneStateError(
          "Specify only vaultId or an exact vaultName (1-240 characters)",
        );
      }
      const name = params.vaultName.trim().toLowerCase();
      const matches = this.snapshot({ userId }).vaults.filter(
        (vault) => vault.name.trim().toLowerCase() === name,
      );
      if (matches.length !== 1) {
        throw new KnowledgeVaultSearchError(
          matches.length ? "vault-name-ambiguous" : "vault-name-not-found",
          matches.length
            ? "Multiple accessible Vaults have that exact name"
            : "No accessible Shared or Managed Vault has that exact name",
          matches.length
            ? "Ask the user to select a Vault; retry with its vaultId. Open Memory Hub for the full catalog."
            : "Check the exact name and access in Memory Hub, then retry. Personal knowledge remains available through the default search.",
          matches
            .slice(0, 5)
            .map((vault) => ({ vaultId: vault.id, vaultName: vault.name, vaultType: vault.type })),
        );
      }
      vaultId = matches[0]!.id;
    }
    const vaultIds =
      vaultId || params.scope === "all"
        ? undefined
        : params.turnScope
          ? params.turnScope.vaultIds
          : this.store.vaults.connectionScope(userId).vaultIds;
    const shared =
      vaultId?.startsWith("managed:") || vaultId?.startsWith("personal:")
        ? []
        : this.store.vaults.search({ ...params, userId, vaultId, vaultIds });
    const managed =
      vaultId !== undefined && !vaultId.startsWith("managed:")
        ? []
        : await this.store.searchOrganizationMemory({ ...params, vaultId, vaultIds });
    return mergeKnowledgeSearchHits(
      [
        shared,
        managed.map(
          (hit): KnowledgeSearchHit => ({
            vaultId: managedKnowledgeVaultId({ kind: hit.scopeKind, id: hit.scopeId }),
            vaultName: hit.scopeName,
            vaultType: "managed",
            documentId: hit.id,
            title: hit.title,
            path: hit.path,
            snippet: hit.snippet,
            revision: hit.revision!,
            score: hit.score,
          }),
        ),
      ],
      params.maxResults ?? 20,
    );
  }

  async get(params: { agentId: string; path: string; fromLine?: number; lineCount?: number }) {
    const userId = this.store.vaults.userIdForAgent(params.agentId);
    if (params.path.startsWith("organization/")) {
      const document = await this.store.getOrganizationMemory(params);
      return document
        ? {
            ...document,
            vaultId: managedKnowledgeVaultId({ kind: document.scopeKind, id: document.scopeId }),
            vaultName: document.scopeName,
            vaultType: "managed",
            documentId: document.id,
          }
        : null;
    }
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
    const lines = document.content
      .split(/\r?\n/u)
      .slice(fromLine - 1, fromLine - 1 + (params.lineCount ?? 50));
    return {
      vaultId: vault.id,
      vaultName: vault.name,
      vaultType: vault.type,
      documentId: document.id,
      revision: document.revision,
      title: document.title,
      path: params.path,
      logicalPath: document.logicalPath,
      content: lines.join("\n").slice(0, 16_384),
      fromLine,
      lineCount: lines.length,
    };
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
