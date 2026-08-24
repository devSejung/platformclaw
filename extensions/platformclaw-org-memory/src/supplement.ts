import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OrganizationMemoryClient } from "./client.js";

const PATH = /^organization\/(global|team|group|part)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

function agentId(value?: string): string {
  if (!value?.trim()) {
    throw new Error("organization memory requires an agent owner");
  }
  return value.trim();
}

export function createOrganizationMemorySupplement(
  client: OrganizationMemoryClient,
  logger: { warn(message: string): void },
) {
  return {
    search: async (params: { query: string; maxResults?: number; agentId?: string }) => {
      try {
        const value = await client.search({
          agentId: agentId(params.agentId),
          query: params.query,
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
            typeof record.scopeName !== "string" ||
            typeof record.snippet !== "string" ||
            typeof record.score !== "number" ||
            typeof record.updatedAt !== "number"
          ) {
            throw new Error("invalid result");
          }
          return {
            corpus: "platformclaw-organization",
            path: record.path,
            title: record.title,
            kind: PATH.exec(record.path)?.[1],
            score: record.score,
            snippet: record.snippet,
            source: "organization",
            provenanceLabel: record.scopeName,
            sourceType: "organization-read-model",
            updatedAt: new Date(record.updatedAt).toISOString(),
          };
        });
      } catch (error) {
        logger.warn(
          `organization memory search unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    },
    get: async (params: {
      lookup: string;
      fromLine?: number;
      lineCount?: number;
      agentId?: string;
    }) => {
      if (!PATH.test(params.lookup)) {
        return null;
      }
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
        typeof record.scopeName !== "string" ||
        typeof record.content !== "string" ||
        typeof record.fromLine !== "number" ||
        typeof record.lineCount !== "number"
      ) {
        throw new Error("organization memory document is invalid");
      }
      return {
        corpus: "platformclaw-organization",
        path: record.path,
        title: record.title,
        kind: PATH.exec(record.path)?.[1],
        content: record.content,
        fromLine: record.fromLine,
        lineCount: record.lineCount,
        provenanceLabel: record.scopeName,
        sourceType: "organization-read-model",
      };
    },
  };
}
