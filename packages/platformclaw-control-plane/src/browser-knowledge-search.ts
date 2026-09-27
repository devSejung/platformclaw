import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  BrowserGatewayProxyError,
  type BrowserGatewayAccess,
  type BrowserGatewayProxyOptions,
} from "./browser-gateway-contracts.js";
import { projectBrowserMemoryResult } from "./browser-gateway-memory.js";
import { projectBrowserWikiResult } from "./browser-gateway-wiki.js";
import { mergeKnowledgeSearchHits } from "./knowledge-vault-contracts.js";

type JsonObject = Record<string, unknown>;
const fail = (message: string): never => {
  throw new BrowserGatewayProxyError("upstream-result-denied", message);
};

function personalHits(
  raw: unknown,
  projected: unknown,
  agentId: string,
  source: "memory" | "wiki",
): JsonObject[] {
  const originals = source === "memory" && isRecord(raw) ? raw.results : raw;
  const results = source === "memory" && isRecord(projected) ? projected.results : projected;
  if (!Array.isArray(originals) || !Array.isArray(results)) {
    return fail("Invalid personal search result");
  }
  return results.map((hit) => {
    if (!isRecord(hit)) {
      return fail("Invalid personal search hit");
    }
    const original = originals.find(
      (entry) => isRecord(entry) && entry.path === hit.path && entry.startLine === hit.startLine,
    );
    const revision = isRecord(original) ? (original.sourceVersion ?? original.revision) : undefined;
    if (
      (typeof revision !== "string" && typeof revision !== "number") ||
      String(revision).length > 256 ||
      !String(revision)
    ) {
      return fail("Personal index lacks source version; rebuild the memory index");
    }
    const result = Object.assign(hit, {
      source,
      vaultId: `personal:${agentId}`,
      vaultName: "Personal",
      vaultType: "personal",
      documentId:
        isRecord(original) && typeof original.documentId === "string"
          ? original.documentId
          : hit.path,
      title: typeof hit.title === "string" ? hit.title : hit.path,
      revision,
      startLine: hit.startLine ?? 1,
      endLine: hit.endLine ?? 1,
    });
    if (isRecord(original) && original.indexStatus === "failed") {
      result.indexStatus = "failed";
      result.indexError =
        typeof original.indexError === "string"
          ? original.indexError.slice(0, 500)
          : "Rebuild the Personal Wiki index";
      if (typeof original.nextRetryAt === "number" && Number.isFinite(original.nextRetryAt)) {
        result.nextRetryAt = original.nextRetryAt;
      }
    }
    return result;
  });
}

/** Selects scope before queries and merges only authorized, provenance-bearing results. */
export async function requestBrowserKnowledgeSearch(
  options: BrowserGatewayProxyOptions,
  access: BrowserGatewayAccess,
  method: string,
  request: JsonObject,
): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (!options.vaultService || (method !== "memory.search" && method !== "wiki.search")) {
    return { handled: false };
  }
  const agentId = access.binding.agentId;
  const vaultId = request.vaultId as string | undefined;
  const maxResults = (request.maxResults as number | undefined) ?? 20;
  const query = request.query as string;
  const scope = request.scope === "all" ? "all" : "connected";
  const includePersonal = vaultId === undefined || vaultId === `personal:${agentId}`;
  if (vaultId?.startsWith("personal:") && !includePersonal) {
    throw new BrowserGatewayProxyError("cross-agent-denied", "Personal vault unavailable");
  }
  const work: Array<{ name: string; run: () => Promise<JsonObject[]> }> = [];
  if (includePersonal && method === "memory.search") {
    work.push({
      name: "personalMemory",
      run: async () => {
        const pinned = { agentId, query, maxResults };
        const raw = await options.gateway.request("memory.search", pinned);
        const projected = projectBrowserMemoryResult({
          method: "memory.search",
          result: raw,
          request: pinned,
          agentId,
          fail,
        });
        return personalHits(raw, projected, agentId, "memory");
      },
    });
  }
  if (includePersonal) {
    work.push({
      name: "personalWiki",
      run: async () => {
        const pinned = {
          agentId,
          query,
          maxResults,
          corpus: "wiki",
          vaultId: `personal:${agentId}`,
          ...(request.mode === undefined ? {} : { mode: request.mode }),
        };
        const raw = await options.gateway.request("wiki.search", pinned);
        const projected = projectBrowserWikiResult({
          method: "wiki.search",
          result: raw,
          request: pinned,
          agentId,
          fail,
        });
        return personalHits(raw, projected, agentId, "wiki");
      },
    });
  }
  if (!vaultId?.startsWith("personal:")) {
    // The service owns Shared membership and the existing organization read policy.
    work.push({
      name: "sharedVault",
      run: async () =>
        (await options.vaultService!.search({ agentId, query, maxResults, vaultId, scope })).map(
          (hit) =>
            Object.assign(hit, {
              source: hit.vaultType === "managed" ? "organization" : "shared",
              provenanceLabel: hit.vaultName,
              startLine: 1,
              endLine: 1,
              kind: hit.vaultType === "managed" ? hit.path.split("/")[1] : undefined,
            }),
        ),
    });
  }
  const outcomes = await Promise.allSettled(work.map((entry) => entry.run()));
  const ranked = outcomes.map((outcome) => (outcome.status === "fulfilled" ? outcome.value : []));
  const results = mergeKnowledgeSearchHits(ranked, maxResults);
  const failed = outcomes.flatMap((outcome, i) =>
    outcome.status === "rejected" ? [work[i]!.name] : [],
  );
  if (failed.length === work.length || (method === "wiki.search" && failed.length)) {
    throw new BrowserGatewayProxyError(
      "agent-unavailable",
      "Knowledge search incomplete; check vault access and rebuild unavailable indexes",
    );
  }
  return {
    handled: true,
    result:
      method === "wiki.search"
        ? results
        : {
            agentId,
            provider: "knowledge-vaults",
            searchMode: "hybrid",
            results,
            ...Object.fromEntries(failed.map((name) => [`${name}Unavailable`, true])),
          },
  };
}
