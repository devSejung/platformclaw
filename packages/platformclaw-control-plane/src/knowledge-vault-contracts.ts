type KnowledgeVaultType = "personal" | "shared";
export type KnowledgeVaultRole = "reader" | "editor" | "owner";

export class KnowledgeVaultSearchError extends Error {
  constructor(
    readonly code: "vault-name-ambiguous" | "vault-name-not-found" | "vault-query-invalid",
    message: string,
    readonly action: string,
    readonly vaultChoices: Array<{
      vaultId: string;
      vaultName: string;
      vaultType: KnowledgeVaultType;
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
  link?: string;
  indexStatus?: "failed";
  indexError?: string;
  nextRetryAt?: number;
};

export type KnowledgeVault = {
  id: string;
  name: string;
  type: KnowledgeVaultType;
  description: string;
  role: KnowledgeVaultRole;
  canRead: boolean;
  canEdit: boolean;
  canManageMembers: boolean;
  canExport: boolean;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeVaultCatalogEntry = Omit<KnowledgeVault, "role"> & {
  role: KnowledgeVaultRole | null;
  connected: boolean;
  /** Access was granted, but auto-enable reached the per-user enabled-Wiki limit. */
  connectionIssue?: "capacity";
  /** Explicit administrative owner recovery; never grants document read access. */
  canRecoverOwner?: boolean;
  documentCount?: number;
  attachmentCount?: number;
};

/** Internal run context, never a model-selected search argument. ACLs remain live. */
export type KnowledgeVaultTurnScope = {
  revision: number;
  vaultIds: string[];
  personalEnabled: boolean;
};

type KnowledgeVaultMember = {
  userId: string;
  accountId: string;
  displayName: string;
  role: KnowledgeVaultRole;
};

type KnowledgeVaultOrganizationGrant = {
  scopeId: string;
  scopeName: string;
  scopeKind: "team" | "group" | "part";
  role: KnowledgeVaultRole;
};

export type KnowledgeVaultAccessRequest = {
  id: string;
  vaultId: string;
  vaultName: string;
  userId: string;
  accountId: string;
  displayName: string;
  role: "reader" | "editor";
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  createdAt: number;
  decidedAt?: number;
};

export type KnowledgeVaultGrantTarget = {
  id: string;
  label: string;
  detail: string;
  accountId?: string;
};

export type KnowledgeVaultCompile = {
  status: "pending" | "ready" | "failed";
  indexedRevision: number | string | null;
  error: string | null;
  attempts: number;
  retryAt: number | null;
};

export type KnowledgeVaultDocumentSummary = {
  id: string;
  vaultId: string;
  title: string;
  /** Bounded preview of authored body content, never status or storage metadata. */
  snippet?: string;
  link?: string;
  logicalPath: string;
  revision: number | string;
  updatedAt: number;
  compile: KnowledgeVaultCompile;
  metadata?: KnowledgeVaultDocumentMetadata;
};

type KnowledgeVaultDocumentMetadata = {
  claims: string[];
  questions: string[];
  contradictions: string[];
  sourceType?: string;
  kind?: string;
};

type KnowledgeVaultLink = {
  target: string;
  documentId: string | null;
  logicalPath: string;
  title: string;
};
export type KnowledgeVaultDocument = KnowledgeVaultDocumentSummary & {
  content: string;
  sourceContent?: string;
  editableContent?: string;
  editMode?: "body" | "notes" | null;
  readOnlyReason?: string | null;
  canDelete?: boolean;
  links: KnowledgeVaultLink[];
  linksTruncated?: boolean;
  backlinks: KnowledgeVaultLink[];
};
type KnowledgeVaultAttachment = {
  path: string;
  mediaType: string;
  bytes: number;
  revision: number | string;
};
export type KnowledgeVaultGraph = {
  /** Node metadata comes from selected.documents; edges use each source's indexedRevision. */
  edges: Array<{ source: string; target: string }>;
  /** Personal catalog size is independent of the source owner's bounded graph. */
  nodeIds?: string[];
  unresolvedLinks: number;
  truncated: boolean;
};
export type KnowledgeVaultSnapshot = {
  vaults: KnowledgeVaultCatalogEntry[];
  selectionRevision: number;
  ownRequests: KnowledgeVaultAccessRequest[];
  pendingRequests: KnowledgeVaultAccessRequest[];
  selected?: {
    vault: KnowledgeVault;
    documents: KnowledgeVaultDocumentSummary[];
    documentCount?: number;
    documentsTruncated?: boolean;
    members: KnowledgeVaultMember[];
    grants: KnowledgeVaultOrganizationGrant[];
    attachments: KnowledgeVaultAttachment[];
    attachmentsTruncated?: boolean;
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
  expectedRevision?: number | string;
};

export type KnowledgeVaultDocumentImportInput = {
  userId: string;
  vaultId: string;
  importId: string;
  documents: Array<{ relativePath: string; content: string }>;
};

export type KnowledgeVaultDocumentImportResult = {
  importId: string;
  rootPath: string;
  documents: Array<
    { relativePath: string; path: string } & (
      | { status: "saved" | "unchanged"; title: string; revision: string }
      | { status: "failed"; error: "conflict" | "unavailable" | "invalid" }
    )
  >;
  indexesRefreshed: boolean;
};

export type KnowledgeVaultDocumentPublishInput = {
  userId: string;
  vaultId: string;
  targetVaultId: string;
  publishId: string;
  documents: Array<{ documentId: string; expectedRevision: string }>;
};

export type KnowledgeVaultDocumentPublishResult = {
  publishId: string;
  targetVaultId: string;
  rootPath: string;
  documents: Array<
    { sourceDocumentId: string } & (
      | {
          status: "published" | "unchanged";
          documentId: string;
          logicalPath: string;
          revision: number;
          compile: KnowledgeVaultCompile;
        }
      | { status: "failed"; error: "conflict" | "unavailable" | "invalid" | "forbidden" }
    )
  >;
};

export const KNOWLEDGE_VAULT_LIMITS = {
  connections: 256,
  documentBytes: 1024 * 1024,
  importDocuments: 100,
  // Even sixfold JSON escaping stays below the existing 25 MiB Gateway frame limit.
  importBytes: 4 * 1024 * 1024,
  publishDocuments: 100,
  publishBytes: 4 * 1024 * 1024,
  attachmentBytes: 8 * 1024 * 1024,
  archiveBytes: 32 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  files: 1000,
  graphEdges: 2000,
} as const;
