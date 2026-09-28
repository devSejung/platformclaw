// Memory Wiki plugin module implements tool behavior.
import path from "node:path";
import { optionalFiniteNumberSchema, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import {
  getMemoryCorpusSupplementResult,
  searchMemoryCorpusSupplements,
  formatMemoryCorpusSupplementFailure,
  type MemoryCorpusSupplementFailure,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { AnyAgentTool, OpenClawConfig } from "../api.js";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import {
  getMemoryWikiPage,
  mergeWikiSearchCorpusResults,
  searchMemoryWiki,
  toSupplementWikiGetResult,
  toSupplementWikiSearchResult,
  WIKI_SEARCH_MODES,
} from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { renderMemoryWikiStatus, resolveMemoryWikiStatus } from "./status.js";

function formatWikiToolReportPath(config: ResolvedMemoryWikiConfig, reportPath: string): string {
  const vaultRoot = path.resolve(config.vault.path);
  const resolvedReportPath = path.resolve(reportPath);
  const relativeReportPath = path.relative(vaultRoot, resolvedReportPath);
  if (
    !relativeReportPath ||
    relativeReportPath.startsWith("..") ||
    path.isAbsolute(relativeReportPath)
  ) {
    return reportPath;
  }
  return relativeReportPath.replace(/\\/g, "/");
}

const WikiStatusSchema = Type.Object({}, { additionalProperties: false });
const WikiLintSchema = Type.Object({}, { additionalProperties: false });
const WikiSearchModeSchema = stringEnum(WIKI_SEARCH_MODES);
const WikiSearchSchema = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      description:
        "Short distinctive keywords from the document; lexical search does not invent synonyms.",
    }),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    vaultId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description:
          "Exact vaultId from a result, only when explicitly selected by the user. Do not combine with vaultName.",
      }),
    ),
    vaultName: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 240,
        description:
          "Exact Shared/Managed vault name explicitly selected by the user. Ask the user to choose if ambiguous; never guess. Do not combine with vaultId.",
      }),
    ),
    mode: Type.Optional({
      ...WikiSearchModeSchema,
      description: "Optional Personal Wiki ranking mode; omit for ordinary document search.",
    }),
  },
  { additionalProperties: false, not: { required: ["vaultId", "vaultName"] } },
);
const WikiGetSchema = Type.Object(
  {
    lookup: Type.String({ minLength: 1 }),
    fromLine: Type.Optional(Type.Integer({ minimum: 1 })),
    lineCount: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description: "Number of lines to read, from 1 to 200.",
      }),
    ),
  },
  { additionalProperties: false },
);
const WikiClaimEvidenceSchema = Type.Object(
  {
    kind: Type.Optional(Type.String({ minLength: 1 })),
    sourceId: Type.Optional(Type.String({ minLength: 1 })),
    path: Type.Optional(Type.String({ minLength: 1 })),
    lines: Type.Optional(Type.String({ minLength: 1 })),
    weight: optionalFiniteNumberSchema({ minimum: 0 }),
    note: Type.Optional(Type.String({ minLength: 1 })),
    confidence: optionalFiniteNumberSchema({ minimum: 0, maximum: 1 }),
    privacyTier: Type.Optional(Type.String({ minLength: 1 })),
    updatedAt: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const WikiClaimSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1 })),
    text: Type.String({ minLength: 1 }),
    status: Type.Optional(Type.String({ minLength: 1 })),
    confidence: optionalFiniteNumberSchema({ minimum: 0, maximum: 1 }),
    evidence: Type.Optional(Type.Array(WikiClaimEvidenceSchema)),
    updatedAt: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const WikiRelationshipSchema = Type.Object(
  {
    lookup: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal("reference"),
      Type.Literal("enrichment"),
      Type.Literal("condition-difference"),
      Type.Literal("duplicate"),
      Type.Literal("conflict"),
    ]),
    status: Type.Union([Type.Literal("confirmed"), Type.Literal("candidate")]),
    expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    confidence: Type.Optional(optionalFiniteNumberSchema({ minimum: 0, maximum: 1 })),
    note: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const WikiApplySchema = Type.Object(
  {
    op: Type.Union([
      Type.Literal("create_synthesis"),
      Type.Literal("update_metadata"),
      Type.Literal("synthesis"),
      Type.Literal("metadata"),
      Type.Literal("refresh"),
    ]),
    title: Type.Optional(Type.String({ minLength: 1 })),
    body: Type.Optional(Type.String({ minLength: 1 })),
    lookup: Type.Optional(Type.String({ minLength: 1 })),
    sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    claims: Type.Optional(Type.Array(WikiClaimSchema)),
    contradictions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    questions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    confidence: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()])),
    status: Type.Optional(Type.String({ minLength: 1 })),
    relationships: Type.Optional(Type.Array(WikiRelationshipSchema)),
  },
  { additionalProperties: false },
);

async function syncImportedSourcesIfNeeded(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
) {
  await syncMemoryWikiImportedSources({ config, appConfig });
}

type WikiToolMemoryContext = {
  runId?: string;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
};

type WikiCorpusStatus = {
  pluginId: string;
  status: "ok" | "empty" | "unavailable" | "failed";
  failure?: MemoryCorpusSupplementFailure;
};

function wikiCorpusWarnings(statuses: WikiCorpusStatus[]): string[] {
  return statuses.flatMap(({ pluginId, status, failure }) =>
    status === "unavailable" || status === "failed"
      ? [
          failure
            ? formatMemoryCorpusSupplementFailure(failure)
            : `Wiki corpus from plugin "${pluginId}" is ${
                status === "unavailable" ? "not configured" : "temporarily unavailable"
              }.`,
        ]
      : [],
  );
}

export function createWikiStatusTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_status",
    label: "Wiki Status",
    description:
      "Inspect the Personal Wiki mode, health, compilation state, and Obsidian CLI availability. Shared/Managed vault status is available in their Vault UI.",
    parameters: WikiStatusSchema,
    execute: async () => {
      await syncImportedSourcesIfNeeded(config, appConfig);
      const status = await resolveMemoryWikiStatus(config, {
        appConfig,
        callerAgentId: memoryContext.agentId,
      });
      return {
        content: [{ type: "text", text: renderMemoryWikiStatus(status) }],
        details: status,
      };
    },
  };
}

export function createWikiSearchTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_search",
    label: "Wiki Search",
    description:
      "Search accessible document titles and content using short distinctive keywords. Omit vaultId and vaultName for the server-selected scope. Use a returned vaultId or exact Shared/Managed vaultName only when the user explicitly selects a vault. Ambiguous names return choices: ask, never guess. Results include vault identity, exact read path, and document version. Personal Wiki additionally supports path/id matching and ranking modes.",
    parameters: WikiSearchSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        query: string;
        maxResults?: number;
        vaultId?: string;
        vaultName?: string;
        mode?: (typeof WIKI_SEARCH_MODES)[number];
      };
      if (params.vaultId && params.vaultName) {
        const error =
          "Choose only vaultId or vaultName; use the explicitly selected ID or exact Shared/Managed name, never both.";
        return { content: [{ type: "text", text: error }], details: { results: [], error } };
      }
      const corpusStatus: WikiCorpusStatus[] = [];
      const maxResults = Math.min(50, Math.max(1, Math.floor(params.maxResults ?? 10)));
      let personalError: string | undefined;
      const personalResults = await (async () => {
        if (params.vaultName) {
          return [];
        }
        if (
          !params.vaultId ||
          params.vaultId === `personal:${memoryContext.agentId ?? config.agentId ?? "main"}`
        ) {
          await syncImportedSourcesIfNeeded(config, appConfig);
        }
        return await searchMemoryWiki({
          config,
          appConfig,
          agentId: memoryContext.agentId,
          agentSessionKey: memoryContext.agentSessionKey,
          sandboxed: memoryContext.sandboxed,
          conversationRecall: memoryContext.conversationRecall,
          query: params.query,
          maxResults,
          ...(params.vaultId ? { vaultId: params.vaultId } : {}),
          ...(params.mode ? { mode: params.mode } : {}),
        });
      })().catch((error: unknown) => {
        personalError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        corpusStatus.push({ pluginId: "memory-wiki", status: "failed" });
        return [];
      });
      const supplementResults = (
        await searchMemoryCorpusSupplements({
          query: params.query,
          runId: memoryContext.runId,
          ...(params.vaultId ? { vaultId: params.vaultId } : {}),
          ...(params.vaultName ? { vaultName: params.vaultName } : {}),
          maxResults,
          agentId: memoryContext.agentId,
          agentSessionKey: memoryContext.agentSessionKey,
          sandboxed: memoryContext.sandboxed,
          excludePluginId: "memory-wiki",
          onSupplementStatus: (pluginId, status, failure) =>
            corpusStatus.push({ pluginId, status, ...(failure ? { failure } : {}) }),
        })
      ).map((result) => toSupplementWikiSearchResult(result, params.mode ?? "auto"));
      const results = mergeWikiSearchCorpusResults({
        wikiResults: personalResults,
        memoryResults: supplementResults,
        maxResults,
        balanceCorpora: true,
      });
      const warnings = wikiCorpusWarnings(corpusStatus);
      if (personalError) {
        warnings.push(
          `Personal Wiki compile/search failed: ${personalError}. Rebuild the Wiki index.`,
        );
      }
      const failedIndex = results.find((result) => result.indexStatus === "failed");
      if (failedIndex) {
        warnings.push(
          `${failedIndex.vaultName ?? "Wiki"} uses its last successful index: ${failedIndex.indexError ?? "compile failed"}. Automatic retry is scheduled. Correct the source and use Rebuild in that vault's UI; Personal Wiki refresh does not rebuild Shared vaults.`,
        );
      }
      const resultText =
        results.length === 0
          ? "No wiki or memory results."
          : results
              .map(
                (result, index) =>
                  `${index + 1}. ${result.title} (${result.corpus}/${result.kind})\nVault: ${result.vaultName} (${result.vaultType}, ${result.vaultId})\nDocument: ${result.documentId}\nVersion: ${result.revision ?? result.sourceVersion}\nPath: ${result.path}${typeof result.startLine === "number" && typeof result.endLine === "number" ? `\nLines: ${result.startLine}-${result.endLine}` : ""}${result.provenanceLabel ? `\nProvenance: ${result.provenanceLabel}` : ""}${result.matchedClaimId ? `\nClaim: ${result.matchedClaimId}` : ""}${result.evidenceKinds && result.evidenceKinds.length > 0 ? `\nEvidence: ${result.evidenceKinds.join(", ")}` : ""}\nSnippet: ${result.snippet}`,
              )
              .join("\n\n");
      const text = [...warnings, resultText].join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: {
          results,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(corpusStatus.length > 0 ? { corpusStatus } : {}),
        },
      };
    },
  };
}

export function createWikiLintTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "wiki_lint",
    label: "Wiki Lint",
    description:
      "Lint Personal Wiki and surface structural issues, provenance gaps, contradictions, and open questions. This does not lint Shared/Managed vaults.",
    parameters: WikiLintSchema,
    execute: async () => {
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await lintMemoryWikiVault(config);
      const contradictions = result.issuesByCategory.contradictions.length;
      const openQuestions = result.issuesByCategory["open-questions"].length;
      const provenance = result.issuesByCategory.provenance.length;
      const errors = result.issues.filter((issue) => issue.severity === "error").length;
      const warnings = result.issues.filter((issue) => issue.severity === "warning").length;
      const reportPath = formatWikiToolReportPath(config, result.reportPath);
      const summary =
        result.issueCount === 0
          ? "No wiki lint issues."
          : [
              `Issues: ${result.issueCount} total (${errors} errors, ${warnings} warnings)`,
              `Contradictions: ${contradictions}`,
              `Open questions: ${openQuestions}`,
              `Provenance gaps: ${provenance}`,
              `Report: ${reportPath}`,
            ].join("\n");
      return {
        content: [{ type: "text", text: summary }],
        details: {
          issueCount: result.issueCount,
          issues: result.issues,
          issuesByCategory: result.issuesByCategory,
          reportPath,
        },
      };
    },
  };
}

export function createWikiApplyTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "wiki_apply",
    label: "Wiki Apply",
    description:
      "Apply narrow Personal Wiki mutations only; op=refresh rebuilds only Personal Wiki. Shared/Managed documents must be edited or rebuilt through their Vault UI with appropriate permissions. Before filing, inspect relevant Personal Wiki candidates; for relationships pass each Personal target's current contentHash as expectedRevision. Use confirmed for supported references, candidate for uncertain relationships. sourceIds are provenance, not links. No relationship is required when unsupported.",
    parameters: WikiApplySchema,
    execute: async (_toolCallId, rawParams) => {
      await syncImportedSourcesIfNeeded(config, appConfig);
      if ((rawParams as { op?: unknown }).op === "refresh") {
        const compile = await compileMemoryWikiVault(config);
        return {
          content: [
            {
              type: "text",
              text: `Refreshed Personal Wiki indexes and Graph (${compile.updatedFiles.length} changed files).`,
            },
          ],
          details: { operation: "refresh", indexesRefreshed: true, compile },
        };
      }
      const mutation = normalizeMemoryWikiMutationInput(rawParams);
      const result = await applyMemoryWikiMutation({ config, mutation });
      const action = result.changed ? "Updated" : "No changes for";
      const compileSummary = !result.indexesRefreshed
        ? "The page was saved, but indexes and Graph were not refreshed. Preserve the draft and call wiki_apply with op=refresh."
        : result.compile && result.compile.updatedFiles.length > 0
          ? `Refreshed ${result.compile.updatedFiles.length} index file${result.compile.updatedFiles.length === 1 ? "" : "s"}.`
          : "Indexes unchanged.";
      return {
        content: [
          {
            type: "text",
            text: `${action} ${result.pagePath} via ${result.operation}. ${compileSummary}`,
          },
        ],
        details: result,
      };
    },
  };
}

export function createWikiGetTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_get",
    label: "Wiki Get",
    description:
      "Read an authorized document using the exact path returned by search. Personal Wiki also accepts its page IDs and index.md for browsing. Shared/Managed documents require the returned full path, not a bare documentId. The server routes the path; no backend or corpus choice is needed.",
    parameters: WikiGetSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        lookup: string;
        fromLine?: number;
        lineCount?: number;
      };
      const corpusStatus: WikiCorpusStatus[] = [];
      // An exact supplementary path belongs to its registered owner. Resolve it
      // before touching Personal sources so an unrelated sync failure cannot block it.
      const supplement = await getMemoryCorpusSupplementResult({
        lookup: params.lookup,
        fromLine: Math.max(1, Math.floor(params.fromLine ?? 1)),
        lineCount: Math.max(1, Math.floor(params.lineCount ?? 200)),
        failurePolicy: "continue",
        agentId: memoryContext.agentId,
        agentSessionKey: memoryContext.agentSessionKey,
        sandboxed: memoryContext.sandboxed,
        excludePluginId: "memory-wiki",
        onSupplementStatus: (pluginId, status, failure) =>
          corpusStatus.push({ pluginId, status, ...(failure ? { failure } : {}) }),
      });
      let result = supplement ? toSupplementWikiGetResult(supplement) : null;
      const ownerFailure = corpusStatus.some(({ failure }) => failure);
      if (!result && !ownerFailure) {
        await syncImportedSourcesIfNeeded(config, appConfig);
        result = await getMemoryWikiPage({
          config,
          appConfig,
          agentId: memoryContext.agentId,
          agentSessionKey: memoryContext.agentSessionKey,
          sandboxed: memoryContext.sandboxed,
          conversationRecall: memoryContext.conversationRecall,
          lookup: params.lookup,
          fromLine: params.fromLine,
          lineCount: params.lineCount,
        });
      }
      const warnings = wikiCorpusWarnings(corpusStatus);
      if (!result) {
        return {
          content: [
            {
              type: "text",
              text: [
                ...warnings,
                ownerFailure
                  ? "The document owner could not provide this path. Follow the reported action."
                  : `Wiki page not found: ${params.lookup}`,
              ].join("\n\n"),
            },
          ],
          details: {
            found: false,
            ...(ownerFailure ? { disabled: true } : {}),
            ...(warnings.length > 0 ? { warnings } : {}),
            ...(corpusStatus.length > 0 ? { corpusStatus } : {}),
          },
        };
      }
      return {
        content: [{ type: "text", text: result.content }],
        details: {
          found: true,
          ...result,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(corpusStatus.length > 0 ? { corpusStatus } : {}),
        },
      };
    },
  };
}
