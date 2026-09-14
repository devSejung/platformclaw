import type { ManagedScopeKind } from "./contracts.js";

export type OrganizationMemoryScopeKind = "global" | ManagedScopeKind;
export type OrganizationMemoryPromotionSourceKind = "personal" | ManagedScopeKind;
export type OrganizationMemoryClaimStatus = "active" | "retired" | "purged";
export type OrganizationMemoryPromotionStatus = "pending" | "approved" | "rejected";

export type OrganizationMemorySearchHit = {
  id: string;
  path: string;
  scopeKind: OrganizationMemoryScopeKind;
  scopeId?: string;
  scopeName: string;
  title: string;
  snippet: string;
  score: number;
  updatedAt: number;
};

export type OrganizationMemoryDocument = OrganizationMemorySearchHit & {
  content: string;
  fromLine: number;
  lineCount: number;
  totalLines?: number;
  textTruncated?: boolean;
  verification?: OrganizationMemoryVerification;
};

export type OrganizationMemoryVerification = {
  approvalStatus: "approved";
  revision: number;
  sourceRevision: number;
  sourceStatus: "current" | "changed" | "unavailable";
};

export type OrganizationMemoryGraphKind = OrganizationMemoryScopeKind;
export type OrganizationMemoryGraphEdge =
  | { source: string; target: string; type: "promotion" }
  | {
      source: string;
      target: string;
      type: "reference";
      sourceRevision: number;
      targetRevision: number;
      inputStatus: "current";
    }
  | {
      source: string;
      target: string;
      type: "comparison";
      kind: "duplicate" | "enrichment" | "condition-difference" | "conflict";
      summary: string;
      reportId: string;
      completedAt: number;
      inputStatus: "current";
      reviewStatus: "pending" | "approved" | "kept" | "deferred" | "applied";
      claimRevisions: Array<{ id: string; revision: number }>;
    };

export type OrganizationMemoryGraph = {
  kind: OrganizationMemoryGraphKind;
  scopeId?: string;
  nodes: Array<{
    id: string;
    path: string;
    title: string;
    scopeName: string;
    updatedAt: number;
    verification?: OrganizationMemoryVerification;
  }>;
  edges: OrganizationMemoryGraphEdge[];
  stats: {
    totalPages: number;
    totalNodes: number;
    totalEdges: number;
    truncated: boolean;
    partial: boolean;
  };
};

export type OrganizationMemoryClaim = {
  revisionApproval?: {
    approvedByUserId: string;
    approvedAt: number;
    reason: string;
    proposalId?: string;
  };
  id: string;
  scopeKind: OrganizationMemoryScopeKind;
  scopeName: string;
  scopeId?: string;
  title: string;
  text: string;
  revision: number;
  status: OrganizationMemoryClaimStatus;
  createdAt: number;
  updatedAt: number;
  sourceClaimId?: string;
  promotionTargets?: OrganizationMemoryPromotionTarget[];
  canRetire?: boolean;
  canPurge?: boolean;
};

export type OrganizationMemoryPromotionTarget = {
  kind: OrganizationMemoryScopeKind;
  scopeId?: string;
  scopeName: string;
  mode: "request" | "direct";
};

export type OrganizationMemoryLifecycleScope = {
  kind: OrganizationMemoryScopeKind;
  name: string;
  id?: string;
  parentScopeId?: string;
  canAdminister: boolean;
  canRead: boolean;
};

export type OrganizationMemoryPromotionRequest = {
  references?: OrganizationMemoryReferencesPreview;
  relatedKnowledgeComparison?: import("./organization-memory-knowledge-contracts.js").OrganizationPromotionKnowledgeComparison;
  id: string;
  sourceKind: OrganizationMemoryPromotionSourceKind;
  sourceClaimId?: string;
  sourceRevision: number;
  targetKind: OrganizationMemoryScopeKind;
  targetScopeName: string;
  proposedText: string;
  evidence: string[];
  reason: string;
  status: OrganizationMemoryPromotionStatus;
  createdAt: number;
  decidedAt?: number;
  decisionReason?: string;
  targetClaimId?: string;
  canReview: boolean;
};

export type OrganizationMemoryReferencesPreview = {
  resolved: Array<{ id: string; revision: number; title: string; path: string }>;
  unresolvedCount: number;
  blockedCount: number;
  ambiguousCount: number;
  fingerprint: string;
};

export type OrganizationMemoryLifecycleSnapshot = {
  scopes: OrganizationMemoryLifecycleScope[];
  personalTargets: OrganizationMemoryPromotionTarget[];
  claims: OrganizationMemoryClaim[];
  submitted: OrganizationMemoryPromotionRequest[];
  reviewable: OrganizationMemoryPromotionRequest[];
  canApproveGlobal: boolean;
  next?: {
    claims?: number;
    submitted?: number;
    reviewable?: number;
  };
};

/** Trusted resolution of a personal Wiki page before shared-memory promotion. */
export type PersonalOrganizationMemorySource = {
  claimId: string;
  revision: number;
  references?: PersonalOrganizationMemoryReference[];
  referencesTextHash?: string;
};

export type PersonalOrganizationMemoryReference = {
  start: number;
  end: number;
  claimId?: string;
  revision?: number;
  kind?: OrganizationMemoryPromotionSourceKind | "global";
  scopeId?: string;
};

export type PersonalOrganizationMemorySourceResolver = (params: {
  agentId: string;
  lookup: string;
  proposedText?: string;
}) => Promise<PersonalOrganizationMemorySource | null>;

export type OrganizationMemoryPromotionReferenceParameters = {
  agentId: string;
  sourceKind: OrganizationMemoryPromotionSourceKind;
  sourceClaimId: string;
  expectedSourceRevision?: number;
  targetKind: OrganizationMemoryScopeKind;
  targetScopeId?: string;
  proposedText: string;
};
