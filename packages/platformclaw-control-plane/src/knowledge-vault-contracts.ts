type KnowledgeVaultType = "personal" | "shared" | "managed";
export type KnowledgeVaultRole = "reader" | "editor" | "owner";

export class KnowledgeVaultSearchError extends Error {
  constructor(
    readonly code: "vault-name-ambiguous" | "vault-name-not-found" | "vault-query-invalid",
    message: string,
    readonly action: string,
    readonly vaultChoices: Array<{
      vaultId: string;
      vaultName: string;
      vaultType: "shared" | "managed";
    }> = [],
  ) {
    super(message);
  }
}

/** Preserve each backend's ranking without comparing incompatible numeric score scales. */
export function mergeKnowledgeSearchHits<T>(groups: readonly (readonly T[])[], limit: number): T[] {
  const results: T[] = [];
  for (let rank = 0; rank < limit && results.length < limit; rank++) {
    for (const hits of groups) {
      if (hits[rank] !== undefined && results.length < limit) {
        results.push(hits[rank]!);
      }
    }
  }
  return results;
}

export type KnowledgeSearchHit = {
  vaultId: string;
  vaultName: string;
  vaultType: KnowledgeVaultType;
  documentId: string;
  title: string;
  path: string;
  snippet: string;
  revision: number | string;
  score: number;
  logicalPath?: string;
  indexStatus?: "failed";
  indexError?: string;
  nextRetryAt?: number;
};

export type KnowledgeVault = {
  id: string;
  name: string;
  type: "shared";
  description: string;
  role: KnowledgeVaultRole;
  canEdit: boolean;
  canManageMembers: boolean;
  canExport: boolean;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeVaultCatalogEntry = Omit<KnowledgeVault, "type"> & {
  type: "shared" | "managed";
  connected: boolean;
  documentCount: number;
  attachmentCount: number;
};

/** Internal run context, never a model-selected search argument. ACLs remain live. */
export type KnowledgeVaultTurnScope = { revision: number; vaultIds: string[] };

export type KnowledgeVaultMember = {
  userId: string;
  accountId: string;
  displayName: string;
  role: KnowledgeVaultRole;
  canExport: boolean;
};

export type KnowledgeVaultCompile = {
  status: "pending" | "ready" | "failed";
  indexedRevision: number | null;
  error: string | null;
  attempts: number;
  retryAt: number | null;
};

export type KnowledgeVaultDocumentSummary = {
  id: string;
  vaultId: string;
  title: string;
  logicalPath: string;
  revision: number;
  updatedAt: number;
  compile: KnowledgeVaultCompile;
};

type KnowledgeVaultLink = { documentId: string | null; logicalPath: string; title: string };
export type KnowledgeVaultDocument = KnowledgeVaultDocumentSummary & {
  content: string;
  links: KnowledgeVaultLink[];
  backlinks: KnowledgeVaultLink[];
};
type KnowledgeVaultAttachment = {
  path: string;
  mediaType: string;
  bytes: number;
  revision: number;
};
export type KnowledgeVaultGraph = {
  /** Node metadata comes from selected.documents; edges use each source's indexedRevision. */
  edges: Array<{ source: string; target: string }>;
  unresolvedLinks: number;
  truncated: boolean;
};
export type KnowledgeVaultSnapshot = {
  vaults: KnowledgeVaultCatalogEntry[];
  selectionRevision: number;
  selected?: {
    vault: KnowledgeVault;
    documents: KnowledgeVaultDocumentSummary[];
    members: KnowledgeVaultMember[];
    attachments: KnowledgeVaultAttachment[];
    graph: KnowledgeVaultGraph;
  };
};

export type KnowledgeVaultDocumentInput = {
  userId: string;
  vaultId: string;
  documentId?: string;
  title?: string;
  logicalPath?: string;
  filename?: string;
  content: string;
  expectedRevision?: number;
};

export const KNOWLEDGE_VAULT_LIMITS = {
  connections: 256,
  documentBytes: 1024 * 1024,
  attachmentBytes: 8 * 1024 * 1024,
  archiveBytes: 32 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  files: 1000,
  graphEdges: 2000,
} as const;
