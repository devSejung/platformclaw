type WikiImportInsightItem = {
  pagePath: string;
  title: string;
  riskLevel: "low" | "medium" | "high" | "unknown";
  riskReasons: string[];
  labels: string[];
  topicKey: string;
  topicLabel: string;
  digestStatus: "available" | "withheld";
  activeBranchMessages: number;
  userMessageCount: number;
  assistantMessageCount: number;
  firstUserLine?: string;
  lastUserLine?: string;
  assistantOpener?: string;
  summary: string;
  candidateSignals: string[];
  correctionSignals: string[];
  preferenceSignals: string[];
  createdAt?: string;
  updatedAt?: string;
};

type WikiImportInsightCluster = {
  key: string;
  label: string;
  itemCount: number;
  highRiskCount: number;
  withheldCount: number;
  preferenceSignalCount: number;
  updatedAt?: string;
  items: WikiImportInsightItem[];
};

export type WikiImportInsights = {
  sourceType: "chatgpt";
  totalItems: number;
  totalClusters: number;
  clusters: WikiImportInsightCluster[];
};

type WikiOverviewItem = {
  pagePath: string;
  title: string;
  kind: "entity" | "concept" | "source" | "synthesis" | "report";
  id?: string;
  updatedAt?: string;
  sourceType?: string;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  claims: string[];
  questions: string[];
  contradictions: string[];
  snippet?: string;
};

type WikiOverviewCluster = {
  key: WikiOverviewItem["kind"];
  label: string;
  itemCount: number;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  updatedAt?: string;
  items: WikiOverviewItem[];
};

export type WikiOverview = {
  totalItems: number;
  totalPages: number;
  pageCounts: Record<WikiOverviewItem["kind"], number>;
  totalClaims: number;
  totalQuestions: number;
  totalContradictions: number;
  clusters: WikiOverviewCluster[];
};

export type WikiGraph = {
  nodes: Array<{
    id: string;
    title: string;
    kind: WikiOverviewItem["kind"] | "index";
    updatedAt?: string;
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: "membership" | "reference" | "related" | "candidate";
    kind?: string;
  }>;
  stats: {
    totalPages: number;
    totalNodes: number;
    totalEdges: number;
    unresolvedLinks: number;
    truncated: boolean;
  };
};
