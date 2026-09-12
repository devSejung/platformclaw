export type OrganizationKnowledgeClaim = {
  id: string;
  revision: number;
  text: string;
  evidence: string[];
};

export type OrganizationKnowledgeProposalKind =
  | "duplicate"
  | "enrichment"
  | "condition-difference"
  | "conflict"
  | "insufficient-evidence";

export type OrganizationKnowledgeComparison = {
  kind: OrganizationKnowledgeProposalKind;
  claimIds: string[];
  claimRevisions: Array<{ id: string; revision: number }>;
  summary: string;
  proposedText?: string;
};

export type OrganizationKnowledgeAnalysis = {
  coverage: {
    strategy: "candidate-pairs";
    policyVersion: string;
    candidatePairs: number;
    comparedPairs: number;
    hasUncomparedPairs: boolean;
  };
  summary: string;
  comparisons: OrganizationKnowledgeComparison[];
};

export type OrganizationKnowledgeAnalysisInput = {
  scopeId: string;
  inputFingerprint: string;
  claims: OrganizationKnowledgeClaim[];
};

export type OrganizationKnowledgeAnalyzer = (
  input: OrganizationKnowledgeAnalysisInput,
  signal: AbortSignal,
) => Promise<OrganizationKnowledgeAnalysis>;

export type OrganizationKnowledgeScope = {
  id: string;
  kind: "part" | "group";
  name: string;
  capabilities: {
    canReadReport: boolean;
    canGenerateReport: boolean;
    canReviewProposals: boolean;
    canApplyProposals: boolean;
  };
};

export type OrganizationKnowledgeJob = {
  id: string;
  inputFingerprint: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  failure?: { code: string; message: string };
};

export type OrganizationKnowledgeReport = OrganizationKnowledgeAnalysis & {
  id: string;
  jobId: string;
  completedAt: number;
  inputFingerprint: string;
  inputStatus: "current" | "stale";
  bounds: {
    includedClaims: number;
    totalEligibleClaims: number;
    maxClaims: number;
    maxTextChars: number;
    truncated: boolean;
  };
};

export type OrganizationKnowledgeSourceClaim = {
  id: string;
  revision: number;
  title: string;
  text: string;
  textTruncated?: boolean;
  evidence?: string[];
  evidenceStatus?: "available" | "unavailable";
  evidenceTruncated?: boolean;
};

export type OrganizationKnowledgeProposal = OrganizationKnowledgeComparison & {
  id: string;
  reportId: string;
  revision: number;
  status: "pending" | "approved" | "rejected" | "kept" | "deferred" | "applied";
  sourceClaims: OrganizationKnowledgeSourceClaim[];
  inputStatus: "current" | "stale";
  claimRevisions: Array<{ id: string; revision: number }>;
};

export type OrganizationKnowledgeReview = {
  id: string;
  proposalId: string;
  revision: number;
  decision: "approve" | "reject" | "keep" | "defer" | "apply";
  reason: string;
  occurredAt: number;
  actorUserId?: string;
  actorDisplayName?: string;
  proposal?: OrganizationKnowledgeProposal;
  outcome?: { claimId: string; revision: number };
};

export type OrganizationKnowledgeSnapshot = {
  scope: OrganizationKnowledgeScope;
  lastSuccess: OrganizationKnowledgeReport | null;
  currentJob: OrganizationKnowledgeJob | null;
  proposals: OrganizationKnowledgeProposal[];
  history: OrganizationKnowledgeReview[];
  hasMore: boolean;
  historyHasMore?: boolean;
  nextHistoryCursor?: { occurredAt: number; id: string };
};

export type OrganizationKnowledgeHistoryQuery = {
  historyDecision?: "reject";
  historyCursor?: { occurredAt: number; id: string };
};

export type OrganizationKnowledgeSnapshotResponse = {
  scopes: OrganizationKnowledgeScope[];
  selected: OrganizationKnowledgeSnapshot | null;
  scopesHasMore: boolean;
};

export type OrganizationPromotionKnowledgeComparison = {
  status: "available" | "stale" | "unavailable";
  analysis?: OrganizationKnowledgeAnalysis;
  inputFingerprint?: string;
  comparedAt?: number;
  reason?: string;
  sourceClaims?: OrganizationKnowledgeSourceClaim[];
};
