// Memory Wiki plugin module implements tool behavior.
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import {
  resolveMemoryCorpusScope,
  getMemoryCorpusSupplementResult,
  searchMemoryCorpusSupplements,
  formatMemoryCorpusSupplementFailure,
  type MemoryCorpusSupplementFailure,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { AnyAgentTool, OpenClawConfig } from "../api.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { getMemoryWikiDocument } from "./document-edit.js";
import {
  getMemoryWikiPage,
  mergeWikiSearchCorpusResults,
  searchMemoryWiki,
  toSupplementWikiGetResult,
  toSupplementWikiSearchResult,
  WIKI_SEARCH_MODES,
} from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { runWikiOperation } from "./tool-operations.js";

const WikiTargetProperties = {
  vaultId: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 256,
      description:
        "Exact Wiki identity returned by search or status; use only the target the user selected.",
    }),
  ),
  vaultName: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 240,
      description:
        "Exact Shared Wiki name explicitly selected by the user. Ask when ambiguous; never guess.",
    }),
  ),
};
const WikiStatusSchema = Type.Object(WikiTargetProperties, {
  additionalProperties: false,
  not: { required: ["vaultId", "vaultName"] },
});
const WikiLintSchema = WikiStatusSchema;
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
          "Exact Shared vault name explicitly selected by the user. Ask the user to choose if ambiguous; never guess. Do not combine with vaultId.",
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
const WikiApplySchema = Type.Object(
  {
    ...WikiTargetProperties,
    op: stringEnum(["create", "update", "refresh"]),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    body: Type.Optional(
      Type.String({
        maxLength: 262144,
        description:
          "For create: authored Markdown. For update: replacement editable body/notes from the read result, excluding protected metadata.",
      }),
    ),
    lookup: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1024,
        description: "Exact document path returned by search or read.",
      }),
    ),
    expectedRevision: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description: "Current revision from the latest document read; required for update.",
      }),
    ),
  },
  {
    additionalProperties: false,
    not: { required: ["vaultId", "vaultName"] },
    anyOf: [{ required: ["vaultId"] }, { required: ["vaultName"] }],
  },
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
      "Inspect enabled accessible Wikis and index health. Omit selectors for a bounded combined summary; explicitly select one Wiki by returned vaultId or exact Shared vaultName to narrow. Results identify the Wiki for later writes.",
    parameters: WikiStatusSchema,
    execute: async (_id, rawParams) =>
      runWikiOperation(config, appConfig, {
        ...memoryContext,
        ...(rawParams as { vaultId?: string; vaultName?: string }),
        operation: "status",
      }),
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
      "Search accessible document titles and content using short distinctive keywords. Omit vaultId and vaultName for the server-selected scope. Use a returned vaultId or exact Shared vaultName only when the user explicitly selects a vault. Ambiguous names return choices: ask, never guess. Results include vault identity, exact read path, document version, and ready-to-insert link. Copy link verbatim only into the same Wiki.",
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
          "Choose only vaultId or vaultName; use the explicitly selected ID or exact Shared name, never both.";
        return { content: [{ type: "text", text: error }], details: { results: [], error } };
      }
      const corpusStatus: WikiCorpusStatus[] = [];
      const maxResults = Math.min(50, Math.max(1, Math.floor(params.maxResults ?? 10)));
      let personalError: string | undefined;
      const personalResults = await (async () => {
        if (
          params.vaultName ||
          (!params.vaultId && !(await resolveMemoryCorpusScope(memoryContext)).personalWikiEnabled)
        ) {
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
          `${failedIndex.vaultName ?? "Wiki"} uses its last successful index: ${failedIndex.indexError ?? "compile failed"}. Automatic retry is scheduled. Correct the source and refresh the explicitly selected Wiki to retry now.`,
        );
      }
      const resultText =
        results.length === 0
          ? "No wiki or memory results."
          : results
              .map(
                (result, index) =>
                  `${index + 1}. ${result.title} (${result.corpus}/${result.kind})\nVault: ${result.vaultName} (${result.vaultType}, ${result.vaultId})\nDocument: ${result.documentId}\nVersion: ${result.revision ?? result.sourceVersion}\nPath: ${result.path}${result.link ? `\nLink (same Wiki): ${result.link}` : ""}${typeof result.startLine === "number" && typeof result.endLine === "number" ? `\nLines: ${result.startLine}-${result.endLine}` : ""}${result.provenanceLabel ? `\nProvenance: ${result.provenanceLabel}` : ""}${result.matchedClaimId ? `\nClaim: ${result.matchedClaimId}` : ""}${result.evidenceKinds && result.evidenceKinds.length > 0 ? `\nEvidence: ${result.evidenceKinds.join(", ")}` : ""}\nSnippet: ${result.snippet}`,
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
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_lint",
    label: "Wiki Lint",
    description:
      "Inspect enabled accessible Wikis for broken links, index failures, and recorded document diagnostics. An explicit vaultId or exact Shared vaultName narrows the scope. Findings are bounded; checks report authored metadata rather than inventing semantic contradictions.",
    parameters: WikiLintSchema,
    execute: async (_id, rawParams) =>
      runWikiOperation(config, appConfig, {
        ...memoryContext,
        ...(rawParams as { vaultId?: string; vaultName?: string }),
        operation: "lint",
      }),
  };
}

export function createWikiApplyTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_apply",
    label: "Wiki Apply",
    description: `Create or update a document, or refresh one Wiki's derived index and links. Always select the user's intended Wiki by vaultId or exact Shared vaultName; never guess. ${(memoryContext.agentId ?? config.agentId) ? `Your Personal Wiki target is personal:${memoryContext.agentId ?? config.agentId}.` : "Use status to obtain the Personal Wiki identity."} Create requires title and body. Update requires exact lookup, latest expectedRevision, and replacement editable body/notes; protected metadata stays intact. Read before editing. Insert the returned link verbatim only within the same Wiki; never guess a document path. Permission and conflicts are checked by the owner. Personal content becomes shared only after an explicit copy/publication request.`,
    parameters: WikiApplySchema,
    execute: async (_id, rawParams) => {
      const params = rawParams as {
        vaultId?: string;
        vaultName?: string;
        op: "create" | "update" | "refresh";
        title?: string;
        body?: string;
        lookup?: string;
        expectedRevision?: string;
      };
      const invalid =
        (!params.vaultId && !params.vaultName) ||
        (params.vaultId && params.vaultName) ||
        !["create", "update", "refresh"].includes(params.op) ||
        (params.op === "create" && (!params.title?.trim() || typeof params.body !== "string")) ||
        (params.op === "update" &&
          (!params.lookup || !params.expectedRevision || typeof params.body !== "string")) ||
        (typeof params.body === "string" && Buffer.byteLength(params.body, "utf8") > 262144);
      if (invalid) {
        return {
          content: [
            {
              type: "text",
              text: "Select exactly one Wiki. Create needs title/body; update needs lookup/latest expectedRevision/body (maximum 256 KiB). Read the document before retrying.",
            },
          ],
          details: { error: "invalid-mutation" },
        };
      }
      const { vaultId, vaultName, ...mutation } = params;
      return runWikiOperation(config, appConfig, {
        ...memoryContext,
        vaultId,
        vaultName,
        operation: "apply",
        mutation,
      });
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
      "Read an authorized document using its exact returned path. Results include revision and editable body/notes when permitted; read every page before replacing that body. Use nextFromLine for continuation. Protected metadata is preserved by the owner on update. Shared documents require the full returned path, not a bare documentId. The server routes the path; no backend choice is needed.",
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
      let edit: {
        revision?: string | number;
        editMode?: "body" | "notes" | null;
        readOnlyReason?: string;
        totalLines?: number;
        truncated?: boolean;
        nextFromLine?: number;
        content?: string;
        lineCount?: number;
        fromLine?: number;
      } = {};
      if (!supplement && result.corpus === "wiki") {
        const document = await getMemoryWikiDocument({ config, lookup: result.path });
        if (document) {
          edit = {
            revision: document.revision,
            editMode: document.editMode,
            readOnlyReason: document.readOnlyReason,
          };
          if (document.editableContent !== undefined) {
            const lines = document.editableContent.split("\n");
            const from = Math.max(1, Math.floor(params.fromLine ?? 1));
            const count = Math.min(200, Math.max(1, Math.floor(params.lineCount ?? 200)));
            const selected = lines.slice(from - 1, from - 1 + count);
            const next = from + selected.length;
            edit = {
              ...edit,
              content: selected.join("\n"),
              fromLine: from,
              lineCount: selected.length,
              totalLines: lines.length,
              truncated: next <= lines.length,
              ...(next <= lines.length ? { nextFromLine: next } : {}),
            };
          }
        }
      }
      const documentResult = { ...result, ...edit };
      const header = [
        `Path: ${result.path}`,
        result.link
          ? result.link.length <= 1000
            ? `Link (same Wiki): ${result.link}`
            : "Ready-to-insert link is in the returned link metadata."
          : undefined,
        documentResult.revision !== undefined ? `Revision: ${documentResult.revision}` : undefined,
        documentResult.editMode ? `Editable: ${documentResult.editMode}` : "Read-only document.",
      ]
        .filter(Boolean)
        .join("\n");
      // Reserve the continuation instruction before choosing whole lines, so the
      // final text cap cannot silently cut content while its cursor skips ahead.
      const budget = Math.max(0, Math.min(3_500, 4_000 - header.length - 160));
      let content = documentResult.content;
      if (content.length > budget) {
        const lines: string[] = [];
        let chars = 0;
        for (const line of content.split("\n")) {
          if (chars + line.length + 1 > budget) {
            break;
          }
          lines.push(line);
          chars += line.length + 1;
        }
        content = lines.length
          ? lines.join("\n")
          : "This line exceeds the tool read limit. Open the document in Wiki Hub to read or edit it without truncation.";
        documentResult.lineCount = lines.length;
        documentResult.truncated = true;
        documentResult.nextFromLine = lines.length
          ? (documentResult.fromLine ?? 1) + lines.length
          : undefined;
      }
      const continuation = documentResult.nextFromLine
        ? `Continue from line: ${documentResult.nextFromLine}; read all pages before replacing the body.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: [header, continuation, content].filter(Boolean).join("\n"),
          },
        ],
        details: {
          found: true,
          ...documentResult,
          content,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(corpusStatus.length > 0 ? { corpusStatus } : {}),
        },
      };
    },
  };
}
