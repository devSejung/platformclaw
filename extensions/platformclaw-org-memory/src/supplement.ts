import type {
  MemoryCorpusGetResult,
  MemoryCorpusSearchResult,
  MemoryWikiOperation,
  MemoryWikiOperationResult,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { asRecord, asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  vaultServiceUnavailable,
  type WikiHubMemoryClient,
  type VaultTurnScope,
} from "./client.js";

const PATH = /^shared\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

function vaultIdentity(record: Record<string, unknown>): {
  vaultId: string;
  vaultName: string;
  vaultType: "shared";
  documentId: string;
  revision: string | number;
} {
  if (
    typeof record.vaultId !== "string" ||
    typeof record.vaultName !== "string" ||
    record.vaultType !== "shared" ||
    typeof record.documentId !== "string" ||
    (typeof record.revision !== "string" && typeof record.revision !== "number")
  ) {
    throw new Error("knowledge vault provenance is invalid");
  }
  return {
    vaultId: record.vaultId,
    vaultName: record.vaultName,
    vaultType: record.vaultType,
    documentId: record.documentId,
    revision: record.revision,
  };
}

function agentId(value?: string): string {
  if (!value?.trim()) {
    throw new Error("Wiki Hub requires an agent owner");
  }
  return value.trim();
}

export function createWikiHubCorpusSupplement(
  client:
    | (Pick<WikiHubMemoryClient, "search" | "get"> & Partial<Pick<WikiHubMemoryClient, "wiki">>)
    | null,
  logger: { warn(message: string): void },
  getTurnScope?: (context: { runId?: string; agentId: string }) => VaultTurnScope | undefined,
  resolveScope?: (context: { runId?: string; agentId?: string }) => Promise<VaultTurnScope>,
) {
  return {
    includeByDefault: true,
    ...(resolveScope
      ? {
          scope: async (context: { runId?: string; agentId?: string }) => {
            try {
              return { personalWikiEnabled: (await resolveScope(context)).personalEnabled };
            } catch (error) {
              throw asOptionalRecord(error)?.memoryCorpusFailure
                ? error
                : vaultServiceUnavailable();
            }
          },
        }
      : {}),
    wiki: async (params: MemoryWikiOperation): Promise<MemoryWikiOperationResult | null> => {
      if (params.vaultId?.startsWith("personal:")) {
        return null;
      }
      if (!client?.wiki) {
        throw vaultServiceUnavailable();
      }
      const ownerAgentId = agentId(params.agentId);
      const turnScope =
        params.vaultId || params.vaultName
          ? undefined
          : getTurnScope?.({ runId: params.runId, agentId: ownerAgentId });
      const value = asOptionalRecord(
        await client.wiki({
          ...params,
          agentId: ownerAgentId,
          ...(turnScope ? { turnScope } : {}),
        }),
      );
      const details = asOptionalRecord(value?.details);
      if (typeof value?.text !== "string" || !details) {
        throw vaultServiceUnavailable();
      }
      return { text: value.text.slice(0, 4_000), details };
    },
    status: () =>
      client
        ? ({ available: true } as const)
        : ({ available: false, reason: "not-configured" } as const),
    search: async (params: {
      query: string;
      maxResults?: number;
      agentId?: string;
      vaultId?: string;
      vaultName?: string;
      runId?: string;
    }) => {
      try {
        if (!client) {
          throw new Error("Wiki Hub is not configured");
        }
        const ownerAgentId = agentId(params.agentId);
        const turnScope =
          params.vaultId || params.vaultName
            ? undefined
            : getTurnScope?.({ runId: params.runId, agentId: ownerAgentId });
        const value = await client.search({
          agentId: ownerAgentId,
          query: params.query,
          ...(turnScope ? { turnScope } : {}),
          ...(params.vaultId ? { vaultId: params.vaultId } : {}),
          ...(params.vaultName ? { vaultName: params.vaultName } : {}),
          ...(params.maxResults ? { maxResults: params.maxResults } : {}),
        });
        if (!Array.isArray(value) || value.length > 50) {
          throw new Error("invalid result list");
        }
        return value.map((entry) => {
          const record = asRecord(entry);
          if (
            !record ||
            typeof record.path !== "string" ||
            !PATH.test(record.path) ||
            typeof record.title !== "string" ||
            typeof record.snippet !== "string" ||
            typeof record.score !== "number"
          ) {
            throw new Error("invalid result");
          }
          const identity = vaultIdentity(record);
          const result: MemoryCorpusSearchResult = Object.assign({}, identity, {
            ...(typeof record.link === "string" && record.link.length <= 6148
              ? { link: record.link }
              : {}),
            corpus: "platformclaw-wiki",
            path: record.path,
            title: record.title,
            kind: identity.vaultType,
            score: record.score,
            snippet: record.snippet,
            source: "shared",
            provenanceLabel: String(record.vaultName),
            sourceType: "shared-vault",
          });
          if (record.indexStatus === "failed") {
            result.indexStatus = "failed";
            if (typeof record.indexError === "string") {
              result.indexError = record.indexError.slice(0, 500);
            }
            if (typeof record.nextRetryAt === "number" && Number.isFinite(record.nextRetryAt)) {
              result.nextRetryAt = record.nextRetryAt;
            }
          }
          return result;
        });
      } catch (error) {
        logger.warn(
          `Wiki Hub search unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw asOptionalRecord(error)?.memoryCorpusFailure ? error : vaultServiceUnavailable();
      }
    },
    get: async (params: {
      lookup: string;
      fromLine?: number;
      lineCount?: number;
      agentId?: string;
    }): Promise<MemoryCorpusGetResult | null> => {
      if (!PATH.test(params.lookup)) {
        return null;
      }
      if (!client) {
        throw vaultServiceUnavailable();
      }
      try {
        const value = await client.get({
          agentId: agentId(params.agentId),
          path: params.lookup,
          ...(params.fromLine ? { fromLine: params.fromLine } : {}),
          ...(params.lineCount ? { lineCount: params.lineCount } : {}),
        });
        const record = asRecord(value);
        if (
          !record ||
          typeof record.path !== "string" ||
          !PATH.test(record.path) ||
          typeof record.title !== "string" ||
          typeof record.content !== "string" ||
          typeof record.fromLine !== "number" ||
          typeof record.lineCount !== "number"
        ) {
          throw new Error("Wiki Hub document is invalid");
        }
        const identity = vaultIdentity(record);
        return {
          ...identity,
          ...(typeof record.link === "string" && record.link.length <= 6148
            ? { link: record.link }
            : {}),
          ...(record.editMode === "body" || record.editMode === "notes" || record.editMode === null
            ? { editMode: record.editMode }
            : {}),
          ...(typeof record.readOnlyReason === "string"
            ? { readOnlyReason: record.readOnlyReason.slice(0, 300) }
            : {}),
          ...(typeof record.totalLines === "number" ? { totalLines: record.totalLines } : {}),
          ...(typeof record.truncated === "boolean" ? { truncated: record.truncated } : {}),
          ...(typeof record.nextFromLine === "number" ? { nextFromLine: record.nextFromLine } : {}),
          corpus: "platformclaw-wiki",
          path: record.path,
          title: record.title,
          kind: identity.vaultType,
          content: record.content,
          fromLine: record.fromLine,
          lineCount: record.lineCount,
          provenanceLabel: String(record.vaultName),
          sourceType: "shared-vault",
        };
      } catch (error) {
        throw asOptionalRecord(error)?.memoryCorpusFailure ? error : vaultServiceUnavailable();
      }
    },
  };
}
