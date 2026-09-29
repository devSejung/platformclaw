import { resolveMemoryCorpusScope } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
// Memory Wiki plugin module implements corpus supplement behavior.
import type { OpenClawConfig } from "../api.js";
import type { MemoryWikiConfigResolver } from "./config.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";

export function createWikiCorpusSupplement(params: {
  resolveConfig: MemoryWikiConfigResolver;
  getAppConfig: () => OpenClawConfig | undefined;
}) {
  return {
    includeByDefault: true,
    status: () => ({ available: true as const }),
    search: async (input: {
      query: string;
      runId?: string;
      vaultId?: string;
      vaultName?: string;
      maxResults?: number;
      agentId?: string;
      agentSessionKey?: string;
      sandboxed?: boolean;
    }) => {
      if (
        input.vaultName ||
        (!input.vaultId && !(await resolveMemoryCorpusScope(input)).personalWikiEnabled)
      ) {
        return [];
      }
      const appConfig = params.getAppConfig();
      const config = params.resolveConfig(input.agentId, appConfig);
      return await searchMemoryWiki({
        config,
        appConfig,
        agentId: config.agentId ?? input.agentId,
        agentSessionKey: input.agentSessionKey,
        sandboxed: input.sandboxed,
        query: input.query,
        ...(input.vaultId ? { vaultId: input.vaultId } : {}),
        maxResults: input.maxResults,
        searchBackend: "local",
        searchCorpus: "wiki",
      });
    },
    get: async (input: {
      lookup: string;
      fromLine?: number;
      lineCount?: number;
      agentId?: string;
      agentSessionKey?: string;
      sandboxed?: boolean;
    }) => {
      const appConfig = params.getAppConfig();
      const config = params.resolveConfig(input.agentId, appConfig);
      return await getMemoryWikiPage({
        config,
        appConfig,
        agentId: config.agentId ?? input.agentId,
        agentSessionKey: input.agentSessionKey,
        sandboxed: input.sandboxed,
        lookup: input.lookup,
        fromLine: input.fromLine,
        lineCount: input.lineCount,
        searchBackend: "local",
        searchCorpus: "wiki",
      });
    },
  };
}
