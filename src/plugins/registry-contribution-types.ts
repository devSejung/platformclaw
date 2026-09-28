/** Acyclic contracts for capabilities stored in the installed plugin registry. */
import type { EmbeddingInput } from "../../packages/memory-host-sdk/src/engine-embeddings.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngine } from "../context-engine/types.js";
import type { MemorySearchManager, MemorySearchResult } from "../memory-host-sdk/host/types.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
} from "./embedding-provider-types.js";

export type ContextEngineFactoryContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
};
export type ContextEngineFactory = (
  ctx: ContextEngineFactoryContext,
) => ContextEngine | Promise<ContextEngine>;
export type ContextEngineRegistrationLifecycle = "runtime" | "readOnlyDiscovery";
export type ContextEngineRegistration = {
  factory: ContextEngineFactory;
  owner: string;
  lifecycle: ContextEngineRegistrationLifecycle;
};

type CompactionProviderSummarizationInstructions = {
  identifierPolicy?: "strict" | "off" | "custom";
  identifierInstructions?: string;
};

export interface CompactionProvider {
  id: string;
  label: string;
  summarize(params: {
    messages: unknown[];
    signal?: AbortSignal;
    compressionRatio?: number;
    customInstructions?: string;
    summarizationInstructions?: CompactionProviderSummarizationInstructions;
    previousSummary?: string;
  }): Promise<string>;
}

export type RegisteredCompactionProvider = {
  provider: CompactionProvider;
  ownerPluginId?: string;
};

export type MemoryEmbeddingBatchChunk = {
  text: string;
  embeddingInput?: EmbeddingInput;
};

export type MemoryEmbeddingBatchOptions = {
  agentId: string;
  chunks: MemoryEmbeddingBatchChunk[];
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
  debug: (message: string, data?: Record<string, unknown>) => void;
};

export type MemoryEmbeddingProviderCallOptions = Pick<EmbeddingProviderCallOptions, "signal">;

export type MemoryEmbeddingProviderRuntime = EmbeddingProviderRuntime & {
  sourceWideBatchEmbed?: boolean;
  batchEmbed?: (options: MemoryEmbeddingBatchOptions) => Promise<number[][] | null>;
};

export type MemoryEmbeddingProviderIndexIdentity = EmbeddingProviderIndexIdentity;

export type MemoryEmbeddingProvider = Pick<
  EmbeddingProvider,
  "id" | "model" | "maxInputTokens" | "close"
> & {
  embedQuery: (text: string, options?: MemoryEmbeddingProviderCallOptions) => Promise<number[]>;
  embedBatch: (
    texts: string[],
    options?: MemoryEmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
  embedBatchInputs?: (
    inputs: EmbeddingInput[],
    options?: MemoryEmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
};

export type MemoryEmbeddingProviderCreateOptions = Omit<
  EmbeddingProviderCreateOptions,
  "dimensions" | "local" | "taskType"
> & {
  fallback?: string;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
    contextSize?: number | "auto";
  };
  outputDimensionality?: number;
  taskType?:
    | "RETRIEVAL_QUERY"
    | "RETRIEVAL_DOCUMENT"
    | "SEMANTIC_SIMILARITY"
    | "CLASSIFICATION"
    | "CLUSTERING"
    | "QUESTION_ANSWERING"
    | "FACT_VERIFICATION";
};

export type MemoryEmbeddingProviderCreateResult = {
  provider: MemoryEmbeddingProvider | null;
  runtime?: MemoryEmbeddingProviderRuntime;
};

export type MemoryEmbeddingProviderAdapter = Omit<
  EmbeddingProviderAdapter,
  "create" | "resolveIndexIdentity"
> & {
  autoSelectPriority?: number;
  allowExplicitWhenConfiguredAuto?: boolean;
  supportsMultimodalEmbeddings?: (params: { model: string }) => boolean;
  resolveIndexIdentity?: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => MemoryEmbeddingProviderIndexIdentity;
  create: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => Promise<MemoryEmbeddingProviderCreateResult>;
  shouldContinueAutoSelection?: (err: unknown) => boolean;
};

export type MemoryPromptSectionParams = {
  runId?: string;
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
};

export type MemoryPromptSectionBuilder = (params: MemoryPromptSectionParams) => string[];

export type MemoryPromptSectionPreparer = (
  params: MemoryPromptSectionParams,
) => Promise<readonly string[]>;

export type PreparedMemoryPromptSection = Readonly<{
  context: Readonly<{
    availableTools: readonly string[];
    citationsMode?: MemoryCitationsMode;
    agentId?: string;
    agentSessionKey?: string;
    sandboxed: boolean;
  }>;
  lines: readonly string[];
}>;

export type MemoryCorpusSearchResult = {
  /** Owner-generated same-Wiki Markdown, ready to insert without path guessing. */
  link?: string;
  /** Vault identity is supplied by the owning backend after authorization. */
  vaultId?: string;
  vaultName?: string;
  vaultType?: "personal" | "shared" | "managed";
  documentId?: string;
  revision?: string | number;
  sourceVersion?: string;
  indexStatus?: "failed";
  indexError?: string;
  nextRetryAt?: number;
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  score: number;
  snippet: string;
  id?: string;
  startLine?: number;
  endLine?: number;
  citation?: string;
  source?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};

export type MemoryCorpusGetResult = {
  link?: string;
  vaultId?: string;
  vaultName?: string;
  vaultType?: "personal" | "shared" | "managed";
  documentId?: string;
  revision?: string | number;
  editMode?: "body" | "notes" | null;
  editableContent?: string;
  readOnlyReason?: string;
  totalLines?: number;
  truncated?: boolean;
  nextFromLine?: number;
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  content: string;
  fromLine: number;
  lineCount: number;
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};

export type MemoryCorpusSupplement = {
  /** Owner-prepared Wiki selection; excludes raw automatic Memory and explicit document access. */
  scope?(context: { runId?: string; agentId?: string }): Promise<{ personalWikiEnabled: boolean }>;
  /** Return null only when this owner does not own the explicitly selected vault. */
  wiki?(params: MemoryWikiOperation): Promise<MemoryWikiOperationResult | null>;
  /** Include this corpus when memory_search omits corpus. Explicit narrow corpora still win. */
  includeByDefault?: boolean;
  status?: () =>
    | { available: true }
    | { available: false; reason: "not-configured" | "temporarily-unavailable" };
  search(params: {
    query: string;
    /** Trusted run identity for a corpus owner's turn-prepared state. */
    runId?: string;
    /** Omit to use the owner-selected authorized scope; never infer a vault from the query. */
    vaultId?: string;
    /** Exact Shared/Managed display name explicitly selected by the user; exclusive with vaultId. */
    vaultName?: string;
    maxResults?: number;
    agentId?: string;
    agentSessionKey?: string;
    sandboxed?: boolean;
  }): Promise<MemoryCorpusSearchResult[]>;
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentId?: string;
    agentSessionKey?: string;
    sandboxed?: boolean;
  }): Promise<MemoryCorpusGetResult | null>;
};

export type MemoryWikiOperation = {
  agentId?: string;
  runId?: string;
  vaultId?: string;
  vaultName?: string;
  operation: "status" | "lint" | "apply";
  mutation?: {
    op: "create" | "update" | "refresh";
    title?: string;
    body?: string;
    lookup?: string;
    expectedRevision?: string;
  };
};

export type MemoryWikiOperationResult = { text: string; details: Record<string, unknown> };

export type MemoryCorpusSupplementRegistration = {
  pluginId: string;
  supplement: MemoryCorpusSupplement;
};

export type MemoryPromptSupplementRegistration = {
  pluginId: string;
  builder: MemoryPromptSectionBuilder;
};

export type MemoryPromptPreparationRegistration = {
  pluginId: string;
  prepare: MemoryPromptSectionPreparer;
};

export type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  model?: string;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
  recordWriteProvenance?: (params: {
    workspaceDir: string;
    relativePath: string;
    contentBefore: string;
    contentAfter: string;
    originClass: "agent" | "untrusted";
    observedAt: number;
  }) => Promise<(() => Promise<void>) | void>;
  clearWriteProvenance?: (params: { workspaceDir: string; relativePath: string }) => Promise<void>;
};

export type MemoryFlushPlanResolver = (params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}) => MemoryFlushPlan | null;

export type RegisteredMemorySearchManager = MemorySearchManager;

type MemoryRuntimeQmdConfig = {
  command?: string;
};

type MemoryRuntimeBackendConfig =
  | { backend: "builtin" }
  | { backend: "qmd"; qmd?: MemoryRuntimeQmdConfig };

export type MemoryPluginRuntime = {
  getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status" | "cli";
  }): Promise<{
    manager: RegisteredMemorySearchManager | null;
    debug?: {
      backend?: "builtin" | "qmd";
      purpose?: "default" | "status" | "cli";
      managerMs?: number;
      managerCacheState?:
        | "cached-full-hit"
        | "cached-full-miss"
        | "transient-cli"
        | "transient-status"
        | "pending-create-wait"
        | "fallback-builtin"
        | "recent-failure-cooldown";
      qmdIdentityHash?: string;
      failureCode?: "qmd-unavailable";
    };
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): MemoryRuntimeBackendConfig;
  /** Authorize raw hits before caller-visible use; absent runtimes must not expose session hits. */
  authorizeSearchHits?(params: {
    cfg: OpenClawConfig;
    agentId: string;
    requesterSessionKey: string | undefined;
    sandboxed: boolean;
    hits: MemorySearchResult[];
  }): Promise<MemorySearchResult[]>;
  closeMemorySearchManager?(params: { cfg: OpenClawConfig; agentId: string }): Promise<void>;
  closeAllMemorySearchManagers?(): Promise<void>;
};

type MemoryPluginPublicArtifactContentType = "markdown" | "json" | "text";

export type MemoryPluginPublicArtifact = {
  kind: string;
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: MemoryPluginPublicArtifactContentType;
};

export type MemoryPluginPublicArtifactsProvider = {
  listArtifacts(params: { cfg: OpenClawConfig }): Promise<MemoryPluginPublicArtifact[]>;
};

export type MemoryPluginCapability = {
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
  publicArtifacts?: MemoryPluginPublicArtifactsProvider;
};

export type MemoryPluginCapabilityRegistration = {
  pluginId: string;
  capability: MemoryPluginCapability;
};

export type SessionDiscussionState = "none" | "available" | "open";
export type SessionDiscussionInfo = {
  state: SessionDiscussionState;
  embedUrl?: string;
  openUrl?: string;
};

export type SessionDiscussionProvider = {
  id: string;
  info(params: { sessionKey: string }): Promise<SessionDiscussionInfo>;
  open(params: { sessionKey: string }): Promise<SessionDiscussionInfo>;
};

export type ResolvedPluginRuntimeArtifact = { source: string; rootDir: string };
