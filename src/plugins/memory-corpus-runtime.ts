import { withTimeout } from "../infra/fs-safe.js";
import { listMemoryCorpusSupplements } from "./memory-state.js";
import type {
  MemoryCorpusGetResult,
  MemoryCorpusSearchResult,
} from "./registry-contribution-types.js";

const MEMORY_CORPUS_SUPPLEMENT_TIMEOUT_MS = 10_000;

export type MemoryCorpusSupplementStatus = "ok" | "empty" | "unavailable" | "failed";

type MemoryCorpusSupplementQuery = {
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  corpus?: "memory" | "wiki" | "all" | "sessions";
  excludePluginId?: string;
  onSupplementStatus?: (pluginId: string, status: MemoryCorpusSupplementStatus) => void;
};

type MemoryCorpusGetFailurePolicy = "fail-fast" | "continue";

function selectedMemoryCorpusSupplements(params: MemoryCorpusSupplementQuery) {
  if (params.corpus === "memory" || params.corpus === "sessions") {
    return [];
  }
  return listMemoryCorpusSupplements().filter(
    ({ pluginId, supplement }) =>
      pluginId !== params.excludePluginId &&
      (params.corpus !== undefined || supplement.includeByDefault === true),
  );
}

export async function searchMemoryCorpusSupplements(
  params: MemoryCorpusSupplementQuery & { query: string; maxResults?: number },
): Promise<MemoryCorpusSearchResult[]> {
  const supplements = selectedMemoryCorpusSupplements(params);
  if (supplements.length === 0) {
    return [];
  }
  // Supplements are independent corpora. One optional owner being unavailable must
  // not erase successful personal or organization memory from sibling owners.
  const { excludePluginId: _excludePluginId, onSupplementStatus, ...searchParams } = params;
  const settled = await Promise.allSettled(
    supplements.map(async (registration) => {
      const status = registration.supplement.status?.();
      if (status?.available === false) {
        return { results: [], status: "unavailable" as const };
      }
      // A supplement cannot cancel another owner's useful results by hanging until
      // the caller's outer deadline. The late task is ignored after this bound.
      const results = await withTimeout(
        registration.supplement.search(searchParams),
        MEMORY_CORPUS_SUPPLEMENT_TIMEOUT_MS,
        `memory corpus supplement ${registration.pluginId}`,
      );
      return { results, status: results.length === 0 ? ("empty" as const) : ("ok" as const) };
    }),
  );
  settled.forEach((result, index) => {
    const pluginId = supplements[index]?.pluginId;
    if (!pluginId) {
      return;
    }
    onSupplementStatus?.(pluginId, result.status === "fulfilled" ? result.value.status : "failed");
  });
  const compareResults = (left: MemoryCorpusSearchResult, right: MemoryCorpusSearchResult) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  };
  const maxResults = Math.max(1, params.maxResults ?? 10);
  const successfulCorpora = settled.flatMap((result) =>
    result.status === "fulfilled" && result.value.results.length > 0
      ? [result.value.results.toSorted(compareResults)]
      : [],
  );
  const selected: MemoryCorpusSearchResult[] = [];
  const selectedKeys = new Set<string>();
  for (let rank = 0; selected.length < maxResults; rank += 1) {
    let added = false;
    for (const corpus of successfulCorpora) {
      const result = corpus[rank];
      if (!result) {
        continue;
      }
      const key = `${result.corpus}\u0000${result.path}\u0000${result.id ?? ""}`;
      if (!selectedKeys.has(key)) {
        selectedKeys.add(key);
        selected.push(result);
        added = true;
      }
      if (selected.length >= maxResults) {
        break;
      }
    }
    if (!added) {
      break;
    }
  }
  return selected;
}

export async function getMemoryCorpusSupplementResult(
  params: MemoryCorpusSupplementQuery & {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    failurePolicy?: MemoryCorpusGetFailurePolicy;
  },
): Promise<MemoryCorpusGetResult | null> {
  const supplements = selectedMemoryCorpusSupplements(params);
  const {
    excludePluginId: _excludePluginId,
    failurePolicy = "fail-fast",
    onSupplementStatus,
    ...getParams
  } = params;
  for (const registration of supplements) {
    // memory_get historically fails with its selected corpus. Only aggregate callers
    // that can report partial availability may opt into independent failure isolation.
    if (failurePolicy === "continue" && registration.supplement.status?.().available === false) {
      onSupplementStatus?.(registration.pluginId, "unavailable");
      continue;
    }
    try {
      const result = await withTimeout(
        registration.supplement.get(getParams),
        MEMORY_CORPUS_SUPPLEMENT_TIMEOUT_MS,
        `memory corpus supplement ${registration.pluginId}`,
      );
      onSupplementStatus?.(registration.pluginId, result ? "ok" : "empty");
      if (result) {
        return result;
      }
    } catch (error) {
      onSupplementStatus?.(registration.pluginId, "failed");
      if (failurePolicy === "fail-fast") {
        throw error;
      }
    }
  }
  return null;
}
