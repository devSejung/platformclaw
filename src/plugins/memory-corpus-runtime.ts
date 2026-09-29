import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { withTimeout } from "../infra/fs-safe.js";
import { listMemoryCorpusSupplements } from "./memory-state.js";
import type {
  MemoryCorpusGetResult,
  MemoryCorpusSearchResult,
  MemoryWikiOperation,
  MemoryWikiOperationResult,
} from "./registry-contribution-types.js";

const MEMORY_CORPUS_SUPPLEMENT_TIMEOUT_MS = 10_000;

/** Wiki selection never disables raw automatic Memory; explicit Wiki selectors bypass it. */
export async function resolveMemoryCorpusScope(context: { runId?: string; agentId?: string }) {
  const scopes = await Promise.all(
    listMemoryCorpusSupplements().flatMap(({ supplement }) =>
      supplement.scope
        ? [
            withTimeout(
              supplement.scope(context),
              MEMORY_CORPUS_SUPPLEMENT_TIMEOUT_MS,
              "Wiki scope preparation",
            ),
          ]
        : [],
    ),
  );
  return { personalWikiEnabled: scopes.every((scope) => scope.personalWikiEnabled) };
}

export async function runMemoryWikiSupplementOperation(
  params: MemoryWikiOperation,
): Promise<MemoryWikiOperationResult[]> {
  const results: MemoryWikiOperationResult[] = [];
  for (const { supplement } of listMemoryCorpusSupplements()) {
    if (!supplement.wiki) {
      continue;
    }
    try {
      // Writes are awaited to their owner outcome, never timed out then retried blindly.
      const result = await supplement.wiki(params);
      if (result) {
        results.push({ text: result.text.slice(0, 4_000), details: result.details });
        if (params.vaultId || params.vaultName) {
          break;
        }
      }
    } catch (error) {
      const failure = readOwnerFailure(error) ?? {
        error: "Wiki operation could not be completed.",
        action:
          "Check the Wiki status before retrying. For a write, read the document to verify whether it was saved.",
      };
      results.push({ text: formatMemoryCorpusSupplementFailure(failure), details: { failure } });
      if (params.vaultId || params.vaultName) {
        break;
      }
    }
  }
  return results;
}

export type MemoryCorpusSupplementStatus = "ok" | "empty" | "unavailable" | "failed";

/** Only explicitly marked owner-approved failures may enter model context. */
export type MemoryCorpusSupplementFailure = {
  error: string;
  action?: string;
  code?: string;
  vaultChoices?: Array<{ vaultId: string; vaultName: string; vaultType: "shared" | "managed" }>;
};

function readOwnerFailure(reason: unknown): MemoryCorpusSupplementFailure | undefined {
  const failure = asOptionalRecord(asOptionalRecord(reason)?.memoryCorpusFailure);
  if (typeof failure?.error !== "string") {
    return undefined;
  }
  const choices = Array.isArray(failure.vaultChoices)
    ? failure.vaultChoices
        .slice(0, 5)
        .flatMap<NonNullable<MemoryCorpusSupplementFailure["vaultChoices"]>[number]>((value) => {
          const choice = asOptionalRecord(value);
          return choice &&
            typeof choice.vaultId === "string" &&
            /^[a-zA-Z0-9:._-]{1,256}$/u.test(choice.vaultId) &&
            typeof choice.vaultName === "string" &&
            (choice.vaultType === "shared" || choice.vaultType === "managed")
            ? [
                {
                  vaultId: choice.vaultId,
                  vaultName: choice.vaultName.slice(0, 240),
                  vaultType: choice.vaultType,
                },
              ]
            : [];
        })
    : [];
  return {
    error: failure.error.slice(0, 300),
    ...(typeof failure.action === "string" ? { action: failure.action.slice(0, 300) } : {}),
    ...(typeof failure.code === "string" && /^[a-z0-9-]{1,64}$/u.test(failure.code)
      ? { code: failure.code }
      : {}),
    ...(choices.length ? { vaultChoices: choices } : {}),
  };
}

export function formatMemoryCorpusSupplementFailure(
  failure: MemoryCorpusSupplementFailure,
): string {
  return [
    failure.error,
    failure.action,
    failure.vaultChoices?.length
      ? `Vault choices: ${JSON.stringify(failure.vaultChoices)}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

type MemoryCorpusSupplementQuery = {
  runId?: string;
  vaultId?: string;
  vaultName?: string;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  corpus?: "memory" | "wiki" | "all" | "sessions";
  excludePluginId?: string;
  onSupplementStatus?: (
    pluginId: string,
    status: MemoryCorpusSupplementStatus,
    failure?: MemoryCorpusSupplementFailure,
  ) => void;
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
      // Owners scope before ranking. Enforce exact identity again so an older
      // supplement that ignores the new optional filter cannot broaden a search.
      const scopedResults = params.vaultId
        ? results.filter((result) => result.vaultId === params.vaultId)
        : params.vaultName
          ? results.filter(
              (result) =>
                (result.vaultType === "shared" || result.vaultType === "managed") &&
                result.vaultName?.trim().toLowerCase() === params.vaultName?.trim().toLowerCase(),
            )
          : results;
      return {
        results: scopedResults,
        status: scopedResults.length === 0 ? ("empty" as const) : ("ok" as const),
      };
    }),
  );
  settled.forEach((result, index) => {
    const pluginId = supplements[index]?.pluginId;
    if (!pluginId) {
      return;
    }
    onSupplementStatus?.(
      pluginId,
      result.status === "fulfilled" ? result.value.status : "failed",
      result.status === "rejected" ? readOwnerFailure(result.reason) : undefined,
    );
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
      const key = `${result.vaultId ?? result.corpus}\u0000${result.path}\u0000${result.id ?? ""}`;
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
      const failure = readOwnerFailure(error);
      onSupplementStatus?.(registration.pluginId, "failed", failure);
      if (failurePolicy === "fail-fast") {
        throw error;
      }
      // A marked get failure claims this exact path. Another owner must not
      // substitute a same-path document after denial or an owner outage.
      if (failure) {
        return null;
      }
    }
  }
  return null;
}
