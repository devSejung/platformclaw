// Memory Wiki plugin module implements tool behavior.
import path from "node:path";
import { optionalFiniteNumberSchema } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { AnyAgentTool, OpenClawConfig } from "../api.js";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import { compileMemoryWikiVault } from "./compile.js";
import {
  WIKI_SEARCH_BACKENDS,
  WIKI_SEARCH_CORPORA,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { getMemoryWikiPage, searchMemoryWiki, WIKI_SEARCH_MODES } from "./query.js";
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
const WikiSearchBackendSchema = Type.Union(
  WIKI_SEARCH_BACKENDS.map((value) => Type.Literal(value)),
);
const WikiSearchCorpusSchema = Type.Union(WIKI_SEARCH_CORPORA.map((value) => Type.Literal(value)));
const WikiSearchModeSchema = Type.Union(WIKI_SEARCH_MODES.map((value) => Type.Literal(value)));
const WikiSearchSchema = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    backend: Type.Optional(WikiSearchBackendSchema),
    corpus: Type.Optional(WikiSearchCorpusSchema),
    mode: Type.Optional(WikiSearchModeSchema),
  },
  { additionalProperties: false },
);
const WikiGetSchema = Type.Object(
  {
    lookup: Type.String({ minLength: 1 }),
    fromLine: Type.Optional(Type.Integer({ minimum: 1 })),
    lineCount: Type.Optional(Type.Integer({ minimum: 1 })),
    backend: Type.Optional(WikiSearchBackendSchema),
    corpus: Type.Optional(WikiSearchCorpusSchema),
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
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
};

export function createWikiStatusTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_status",
    label: "Wiki Status",
    description:
      "Inspect the current memory wiki vault mode, health, and Obsidian CLI availability.",
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
      "Search the configured personal Wiki pages by title, path, id, or body text. This tool does not search organization knowledge; use ordinary memory_search for workplace knowledge. Generated indexes stay out of ranking and are browsed with wiki_get.",
    parameters: WikiSearchSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        query: string;
        maxResults?: number;
        backend?: ResolvedMemoryWikiConfig["search"]["backend"];
        corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
        mode?: (typeof WIKI_SEARCH_MODES)[number];
      };
      await syncImportedSourcesIfNeeded(config, appConfig);
      const results = await searchMemoryWiki({
        config,
        appConfig,
        agentId: memoryContext.agentId,
        agentSessionKey: memoryContext.agentSessionKey,
        sandboxed: memoryContext.sandboxed,
        conversationRecall: memoryContext.conversationRecall,
        query: params.query,
        maxResults: params.maxResults,
        ...(params.backend ? { searchBackend: params.backend } : {}),
        ...(params.corpus ? { searchCorpus: params.corpus } : {}),
        ...(params.mode ? { mode: params.mode } : {}),
      });
      const text =
        results.length === 0
          ? "No wiki or memory results."
          : results
              .map(
                (result, index) =>
                  `${index + 1}. ${result.title} (${result.corpus}/${result.kind})\nPath: ${result.path}${typeof result.startLine === "number" && typeof result.endLine === "number" ? `\nLines: ${result.startLine}-${result.endLine}` : ""}${result.provenanceLabel ? `\nProvenance: ${result.provenanceLabel}` : ""}${result.matchedClaimId ? `\nClaim: ${result.matchedClaimId}` : ""}${result.evidenceKinds && result.evidenceKinds.length > 0 ? `\nEvidence: ${result.evidenceKinds.join(", ")}` : ""}\nSnippet: ${result.snippet}`,
              )
              .join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: { results },
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
      "Lint the wiki vault and surface structural issues, provenance gaps, contradictions, and open questions.",
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
      "Apply narrow personal Wiki mutations. Before a substantive create or update, use wiki_search and wiki_get to compare only relevant candidates, then pass each target's current contentHash as expectedRevision. Targets are re-resolved in this vault: use status=confirmed only for a supported reference and status=candidate for an uncertain duplicate, conflict, enrichment, or condition difference. sourceIds remain provenance, not related-page links. No relationship is required when none is supported.",
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
      "Read a configured personal Wiki page or generated index by id or relative path. Start with index.md to browse the whole Wiki, then follow exact returned paths. This tool does not read organization knowledge.",
    parameters: WikiGetSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        lookup: string;
        fromLine?: number;
        lineCount?: number;
        backend?: ResolvedMemoryWikiConfig["search"]["backend"];
        corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
      };
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await getMemoryWikiPage({
        config,
        appConfig,
        agentId: memoryContext.agentId,
        agentSessionKey: memoryContext.agentSessionKey,
        sandboxed: memoryContext.sandboxed,
        conversationRecall: memoryContext.conversationRecall,
        lookup: params.lookup,
        fromLine: params.fromLine,
        lineCount: params.lineCount,
        ...(params.backend ? { searchBackend: params.backend } : {}),
        ...(params.corpus ? { searchCorpus: params.corpus } : {}),
      });
      if (!result) {
        return {
          content: [{ type: "text", text: `Wiki page not found: ${params.lookup}` }],
          details: { found: false },
        };
      }
      return {
        content: [{ type: "text", text: result.content }],
        details: { found: true, ...result },
      };
    },
  };
}
