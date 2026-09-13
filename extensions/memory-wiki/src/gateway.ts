// Memory Wiki plugin module implements gateway behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/memory-host-core";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { OpenClawConfig, OpenClawPluginApi } from "../api.js";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import { compileMemoryWikiVault } from "./compile.js";
import {
  resolveMemoryWikiAgentConfig,
  WIKI_SEARCH_BACKENDS,
  WIKI_SEARCH_CORPORA,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { deleteMemoryWikiPage, MemoryWikiDeleteValidationError } from "./delete.js";
import {
  getMemoryWikiDocument,
  MemoryWikiEditConflictError,
  MemoryWikiEditValidationError,
  saveMemoryWikiDocument,
} from "./document-edit.js";
import { listMemoryWikiImportInsights } from "./import-insights.js";
import { listMemoryWikiImportRuns } from "./import-runs.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { lintMemoryWikiVault } from "./lint.js";
import {
  probeObsidianCli,
  runObsidianCommand,
  runObsidianDaily,
  runObsidianOpen,
  runObsidianSearch,
} from "./obsidian.js";
import { resolveMemoryWikiPromotionReferences } from "./promotion-references.js";
import { getMemoryWikiPage, searchMemoryWiki, WIKI_SEARCH_MODES } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { buildMemoryWikiDoctorReport, resolveMemoryWikiStatus } from "./status.js";
import { initializeMemoryWikiVault } from "./vault.js";
import { listMemoryWikiGraph } from "./wiki-graph.js";
import { listMemoryWikiOverview } from "./wiki-overview.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;
const ADMIN_SCOPE = "operator.admin" as const;
const LOCAL_FILE_INGEST_SCOPE = ADMIN_SCOPE;
type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayRespond = GatewayMethodContext["respond"];

function readStringParam(params: Record<string, unknown>, key: string): string | undefined;
function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true },
): string;
function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: boolean },
): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (options?.required) {
    throw new Error(`${key} is required.`);
  }
  return undefined;
}

function readEnumParam<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = readStringParam(params, key);
  if (!value) {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${key} must be one of: ${allowed.join(", ")}.`);
}

function respondError(respond: GatewayRespond, error: unknown) {
  const message = formatErrorMessage(error);
  respond(false, undefined, { code: "internal_error", message });
}

async function syncImportedSourcesIfNeeded(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
) {
  await syncMemoryWikiImportedSources({ config, appConfig });
}

export function registerMemoryWikiGatewayMethods(params: {
  api: OpenClawPluginApi;
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  getAppConfig?: () => OpenClawConfig | undefined;
  resolveConfig?: (agentId?: string, appConfig?: OpenClawConfig) => ResolvedMemoryWikiConfig;
}) {
  const { api, config: baseConfig } = params;

  const getAppConfig = () => {
    if (params.getAppConfig) {
      return params.getAppConfig();
    }
    if (typeof api.runtime.config?.current === "function") {
      return api.runtime.config.current() as OpenClawConfig;
    }
    return params.appConfig;
  };
  const resolveRequestContext = (requestParams: Record<string, unknown>) => {
    const appConfig = getAppConfig();
    const requestedAgentId = readStringParam(requestParams, "agentId");
    const config = params.resolveConfig
      ? params.resolveConfig(requestedAgentId, appConfig)
      : resolveMemoryWikiAgentConfig({
          config: baseConfig,
          appConfig,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
        });
    const agentId =
      config.agentId ??
      requestedAgentId ??
      (appConfig ? resolveDefaultAgentId(appConfig) : undefined);
    return { agentId, appConfig, config };
  };

  const assertOfficialObsidianCliSupported = (config: ResolvedMemoryWikiConfig) => {
    if (config.vault.scope === "agent") {
      throw new Error(
        "Official Obsidian CLI actions do not support memory-wiki vault.scope=agent.",
      );
    }
  };

  api.registerGatewayMethod(
    "wiki.delete",
    async ({ params: requestParams, respond }) => {
      try {
        if (
          Object.keys(requestParams).some(
            (key) => !["agentId", "path", "expectedContentHash"].includes(key),
          )
        ) {
          throw new MemoryWikiDeleteValidationError(
            "wiki.delete requires path and expectedContentHash only.",
          );
        }
        if (
          typeof requestParams.path !== "string" ||
          typeof requestParams.expectedContentHash !== "string"
        ) {
          throw new MemoryWikiDeleteValidationError("Reload a Wiki page before deleting it.");
        }
        const { agentId, config } = resolveRequestContext(requestParams);
        if (config.vault.scope !== "agent" || !config.agentId) {
          throw new MemoryWikiDeleteValidationError(
            "Wiki deletion requires a personal agent-scoped vault.",
          );
        }
        const result = await deleteMemoryWikiPage({
          config,
          path: requestParams.path,
          expectedContentHash: requestParams.expectedContentHash,
        });
        respond(true, { agentId, ...result });
      } catch (error) {
        respond(false, undefined, {
          code:
            error instanceof MemoryWikiDeleteValidationError ? "INVALID_REQUEST" : "UNAVAILABLE",
          message:
            error instanceof MemoryWikiDeleteValidationError
              ? error.message
              : "Wiki deletion could not be completed. Reload the page and try again.",
        });
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.document.get",
    async ({ params: requestParams, respond }) => {
      try {
        if (Object.keys(requestParams).some((key) => !["agentId", "lookup"].includes(key))) {
          throw new MemoryWikiEditValidationError("wiki.document.get requires lookup only.");
        }
        const { appConfig, config } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        const lookup = readStringParam(requestParams, "lookup", { required: true });
        respond(true, await getMemoryWikiDocument({ config, lookup }));
      } catch (error) {
        respond(false, undefined, {
          code: error instanceof MemoryWikiEditValidationError ? "INVALID_REQUEST" : "UNAVAILABLE",
          message:
            error instanceof MemoryWikiEditValidationError
              ? error.message
              : "Wiki document could not be loaded.",
        });
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.document.save",
    async ({ params: requestParams, respond }) => {
      try {
        if (
          Object.keys(requestParams).some(
            (key) => !["agentId", "path", "editMode", "content", "expectedRevision"].includes(key),
          )
        ) {
          throw new MemoryWikiEditValidationError(
            "wiki.document.save contains unsupported fields.",
          );
        }
        const { config } = resolveRequestContext(requestParams);
        const editMode = readEnumParam(requestParams, "editMode", ["body", "notes"] as const);
        if (!editMode || typeof requestParams.content !== "string") {
          throw new MemoryWikiEditValidationError(
            "wiki.document.save requires editMode and content.",
          );
        }
        respond(
          true,
          await saveMemoryWikiDocument({
            config,
            path: readStringParam(requestParams, "path", { required: true }),
            editMode,
            content: requestParams.content,
            expectedRevision: readStringParam(requestParams, "expectedRevision", {
              required: true,
            }),
          }),
        );
      } catch (error) {
        respond(false, undefined, {
          code:
            error instanceof MemoryWikiEditConflictError
              ? "CONFLICT"
              : error instanceof MemoryWikiEditValidationError
                ? "INVALID_REQUEST"
                : "UNAVAILABLE",
          message:
            error instanceof MemoryWikiEditConflictError ||
            error instanceof MemoryWikiEditValidationError
              ? error.message
              : "Wiki document could not be saved. Your draft was not changed.",
        });
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.status",
    async ({ params: requestParams, respond }) => {
      try {
        const { appConfig, config } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(
          true,
          await resolveMemoryWikiStatus(config, {
            appConfig,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.importRuns",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        const limit = readPositiveIntegerParam(requestParams, "limit");
        respond(true, await listMemoryWikiImportRuns(config, limit !== undefined ? { limit } : {}));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.importInsights",
    async ({ params: requestParams, respond }) => {
      try {
        const { appConfig, config } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(true, await listMemoryWikiImportInsights(config));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  // Renamed from wiki.palace without an alias by maintainer decision: the method was
  // undocumented, its only known consumer is the version-locked Control UI, and stale
  // callers get an explicit unknown-method error rather than a silent failure.
  api.registerGatewayMethod(
    "wiki.overview",
    async ({ params: requestParams, respond }) => {
      try {
        const { appConfig, config } = resolveRequestContext(requestParams);
        const sync = await syncMemoryWikiImportedSources({
          config,
          appConfig,
          ...(requestParams.forceSync === true ? { forceSync: true } : {}),
        });
        respond(true, {
          ...(await listMemoryWikiOverview(config)),
          sourceSyncComplete:
            sync.pendingRemovalCount === 0 &&
            (sync.indexesRefreshed || sync.indexRefreshReason === "no-import-changes"),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.graph",
    async ({ params: requestParams, respond }) => {
      try {
        const { appConfig, config } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(true, await listMemoryWikiGraph(config));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.init",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        respond(true, await initializeMemoryWikiVault(config));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.doctor",
    async ({ params: requestParams, respond }) => {
      try {
        const { appConfig, config } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        const status = await resolveMemoryWikiStatus(config, {
          appConfig,
        });
        respond(true, buildMemoryWikiDoctorReport(status));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.compile",
    async ({ params: requestParams, respond }) => {
      try {
        const { appConfig, config } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(true, await compileMemoryWikiVault(config));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.ingest",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        const inputPath = readStringParam(requestParams, "inputPath", { required: true });
        const title = readStringParam(requestParams, "title");
        respond(
          true,
          await ingestMemoryWikiSource({
            config,
            inputPath,
            ...(title ? { title } : {}),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: LOCAL_FILE_INGEST_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.lint",
    async ({ params: requestParams, respond }) => {
      try {
        const { appConfig, config } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(true, await lintMemoryWikiVault(config));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.bridge.import",
    async ({ params: requestParams, respond }) => {
      try {
        const { appConfig, config } = resolveRequestContext(requestParams);
        respond(
          true,
          await syncMemoryWikiImportedSources({
            config: { ...config, vaultMode: "bridge" },
            appConfig,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.unsafeLocal.import",
    async ({ params: requestParams, respond }) => {
      try {
        const { appConfig, config } = resolveRequestContext(requestParams);
        if (config.vault.scope === "agent") {
          throw new Error("Unsafe-local import does not support memory-wiki vault.scope=agent.");
        }
        respond(
          true,
          await syncMemoryWikiImportedSources({
            config: { ...config, vaultMode: "unsafe-local" },
            appConfig,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.search",
    async ({ params: requestParams, respond }) => {
      try {
        const { agentId, appConfig, config } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        const query = readStringParam(requestParams, "query", { required: true });
        const maxResults = readPositiveIntegerParam(requestParams, "maxResults");
        const searchBackend = readEnumParam(requestParams, "backend", WIKI_SEARCH_BACKENDS);
        const searchCorpus = readEnumParam(requestParams, "corpus", WIKI_SEARCH_CORPORA);
        const mode = readEnumParam(requestParams, "mode", WIKI_SEARCH_MODES);
        respond(
          true,
          await searchMemoryWiki({
            config,
            appConfig,
            ...(agentId ? { agentId } : {}),
            query,
            maxResults,
            searchBackend,
            searchCorpus,
            mode,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.apply",
    async ({ params: requestParams, respond }) => {
      try {
        const { appConfig, config } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(
          true,
          await applyMemoryWikiMutation({
            config,
            mutation: normalizeMemoryWikiMutationInput(requestParams),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.references.resolve",
    async ({ params: requestParams, respond }) => {
      try {
        if (
          Object.keys(requestParams).some(
            (key) => !["agentId", "lookup", "proposedText"].includes(key),
          )
        ) {
          throw new Error(
            "Wiki reference resolution accepts only agentId, lookup, and proposedText.",
          );
        }
        const { appConfig, config } = resolveRequestContext(requestParams);
        const lookup = readStringParam(requestParams, "lookup", { required: true });
        if (
          requestParams.proposedText !== undefined &&
          typeof requestParams.proposedText !== "string"
        ) {
          throw new Error("proposedText must be a string.");
        }
        await syncImportedSourcesIfNeeded(config, appConfig);
        respond(
          true,
          await resolveMemoryWikiPromotionReferences({
            config,
            appConfig,
            lookup,
            ...(typeof requestParams.proposedText === "string"
              ? { proposedText: requestParams.proposedText }
              : {}),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.get",
    async ({ params: requestParams, respond }) => {
      try {
        const { agentId, appConfig, config } = resolveRequestContext(requestParams);
        await syncImportedSourcesIfNeeded(config, appConfig);
        const lookup = readStringParam(requestParams, "lookup", { required: true });
        const fromLine = readPositiveIntegerParam(requestParams, "fromLine");
        const lineCount = readPositiveIntegerParam(requestParams, "lineCount");
        const searchBackend = readEnumParam(requestParams, "backend", WIKI_SEARCH_BACKENDS);
        const searchCorpus = readEnumParam(requestParams, "corpus", WIKI_SEARCH_CORPORA);
        respond(
          true,
          await getMemoryWikiPage({
            config,
            appConfig,
            ...(agentId ? { agentId } : {}),
            lookup,
            fromLine,
            lineCount,
            searchBackend,
            searchCorpus,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.obsidian.status",
    async ({ respond }) => {
      try {
        respond(true, await probeObsidianCli());
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.obsidian.search",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        assertOfficialObsidianCliSupported(config);
        const query = readStringParam(requestParams, "query", { required: true });
        respond(true, await runObsidianSearch({ config, query }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.obsidian.open",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        assertOfficialObsidianCliSupported(config);
        const vaultPath = readStringParam(requestParams, "path", { required: true });
        respond(true, await runObsidianOpen({ config, vaultPath }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.obsidian.command",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        assertOfficialObsidianCliSupported(config);
        const id = readStringParam(requestParams, "id", { required: true });
        respond(true, await runObsidianCommand({ config, id }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "wiki.obsidian.daily",
    async ({ params: requestParams, respond }) => {
      try {
        const { config } = resolveRequestContext(requestParams);
        assertOfficialObsidianCliSupported(config);
        respond(true, await runObsidianDaily({ config }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}
