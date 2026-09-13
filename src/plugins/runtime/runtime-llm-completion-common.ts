// Both completion modes share the same host/operator policy and data-only message projection.
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  normalizeBuiltInProviderModelId,
  stripSelfProviderModelPrefix,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Api, Message } from "../../llm/types.js";
import { modelKey } from "../../shared/model-key.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { normalizePluginsConfig } from "../config-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type {
  LlmCompleteCaller,
  LlmCompleteErrorCode,
  LlmCompleteParams,
  LlmCompleteUsage,
  RuntimeLogger,
} from "./types-core.js";

export type RuntimeLlmAuthority = {
  caller?: LlmCompleteCaller;
  /** Trusted host-derived plugin id used only for config policy lookup. */
  pluginIdForPolicy?: string;
  sessionKey?: string;
  agentId?: string;
  preferredProfile?: string;
  requiresBoundAgent?: boolean;
  allowAgentIdOverride?: boolean;
  allowModelOverride?: boolean;
  allowedModels?: readonly string[];
  allowedCompletionModels?: readonly string[];
  allowAuthProfileOverride?: boolean;
  allowComplete?: boolean;
  denyReason?: string;
};

export type CreateRuntimeLlmOptions = {
  getConfig?: () => OpenClawConfig | undefined;
  authority?: RuntimeLlmAuthority;
  logger?: RuntimeLogger;
};

type RuntimeModelAllowlist = {
  configured: boolean;
  allowAny: boolean;
  models: Set<string>;
};

type RuntimeLlmPolicy = {
  allowAgentIdOverride: boolean;
  allowModelOverride: boolean;
  allowAuthProfileOverride: boolean;
  overrideModels: RuntimeModelAllowlist;
  completionModels: RuntimeModelAllowlist;
};

function normalizeCaller(
  caller?: LlmCompleteCaller,
  fallback?: LlmCompleteCaller,
): LlmCompleteCaller {
  const source = caller ?? fallback;
  if (!source) {
    return { kind: "unknown" };
  }
  return {
    kind: source.kind,
    ...(normalizeOptionalString(source.id) ? { id: source.id!.trim() } : {}),
    ...(normalizeOptionalString(source.name) ? { name: source.name!.trim() } : {}),
  };
}

export function completionError(
  code: LlmCompleteErrorCode,
  message: string,
  cause?: unknown,
): Error & { code: LlmCompleteErrorCode } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & {
    code: LlmCompleteErrorCode;
  };
  error.name = "LlmCompleteError";
  error.code = code;
  return error;
}

export function resolveTrustedCaller(authority?: RuntimeLlmAuthority): LlmCompleteCaller {
  if (authority?.caller?.kind === "context-engine") {
    return normalizeCaller(authority.caller);
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  const scopedPluginId = normalizeOptionalString(scope?.pluginId);
  if (scopedPluginId) {
    return { kind: "plugin", id: scopedPluginId };
  }
  return normalizeCaller(authority?.caller);
}

export function resolveRuntimeConfig(options: CreateRuntimeLlmOptions): OpenClawConfig {
  const cfg = options.getConfig?.();
  if (!cfg) {
    throw new Error("Plugin LLM completion requires an injected runtime config scope.");
  }
  return cfg;
}

export function buildSystemPrompt(params: LlmCompleteParams): string | undefined {
  const segments = [
    normalizeOptionalString(params.systemPrompt),
    ...params.messages
      .filter((message) => message.role === "system")
      .map((message) => normalizeOptionalString(message.content)),
  ].filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("\n\n") : undefined;
}

export function buildMessages(params: {
  request: LlmCompleteParams;
  provider: string;
  model: string;
  api: Api;
}): Message[] {
  const now = Date.now();
  return params.request.messages
    .filter((message) => message.role !== "system")
    .map((message) =>
      message.role === "user"
        ? { role: "user" as const, content: message.content, timestamp: now }
        : {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: message.content }],
            api: params.api,
            provider: params.provider,
            model: params.model,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: now,
          },
    );
}

function readFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readExplicitCostUsd(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const cost = (raw as { cost?: unknown }).cost;
  if (typeof cost === "number") {
    return readFiniteNonNegativeNumber(cost);
  }
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return undefined;
  }
  return (
    readFiniteNonNegativeNumber((cost as { total?: unknown; totalUsd?: unknown }).totalUsd) ??
    readFiniteNonNegativeNumber((cost as { total?: unknown }).total)
  );
}

export function buildUsage(params: {
  rawUsage: unknown;
  normalized: NormalizedUsage | undefined;
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): LlmCompleteUsage {
  const costConfig = resolveModelCostConfig({
    provider: params.provider,
    model: params.model,
    config: params.cfg,
  });
  const costUsd =
    readExplicitCostUsd(params.rawUsage) ??
    estimateUsageCost({ usage: params.normalized, cost: costConfig });
  return {
    ...(params.normalized?.input !== undefined ? { inputTokens: params.normalized.input } : {}),
    ...(params.normalized?.output !== undefined ? { outputTokens: params.normalized.output } : {}),
    ...(params.normalized?.cacheRead !== undefined
      ? { cacheReadTokens: params.normalized.cacheRead }
      : {}),
    ...(params.normalized?.cacheWrite !== undefined
      ? { cacheWriteTokens: params.normalized.cacheWrite }
      : {}),
    ...(params.normalized?.total !== undefined ? { totalTokens: params.normalized.total } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

export function finiteOption(value: number | undefined): number | undefined {
  return asFiniteNumber(value);
}

function normalizeAllowedModelRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  const parsed = parseModelCatalogRef(trimmed);
  if (!parsed) {
    return null;
  }
  // Operator allowlists already name canonical targets; keep policy checks independent
  // of plugin metadata and provider-runtime discovery.
  const modelId = normalizeBuiltInProviderModelId(
    parsed.provider,
    stripSelfProviderModelPrefix(parsed.provider, parsed.modelId),
  );
  return modelKey(parsed.provider, modelId);
}

function normalizeModelAllowlist(params: {
  configured: boolean;
  values?: readonly string[];
}): RuntimeModelAllowlist {
  const models = new Set<string>();
  let allowAny = false;
  for (const modelRef of params.values ?? []) {
    const normalizedModelRef = normalizeAllowedModelRef(modelRef);
    if (!normalizedModelRef) {
      continue;
    }
    if (normalizedModelRef === "*") {
      allowAny = true;
      continue;
    }
    models.add(normalizedModelRef);
  }
  return { configured: params.configured, allowAny, models };
}

function buildPolicyFromEntry(entry: {
  allowAgentIdOverride?: boolean;
  allowModelOverride?: boolean;
  allowAuthProfileOverride?: boolean;
  hasAllowedModelsConfig?: boolean;
  allowedModels?: readonly string[];
  hasAllowedCompletionModelsConfig?: boolean;
  allowedCompletionModels?: readonly string[];
}): RuntimeLlmPolicy {
  return {
    allowAgentIdOverride: entry.allowAgentIdOverride === true,
    allowModelOverride: entry.allowModelOverride === true,
    allowAuthProfileOverride: entry.allowAuthProfileOverride === true,
    overrideModels: normalizeModelAllowlist({
      configured: entry.hasAllowedModelsConfig === true,
      values: entry.allowedModels,
    }),
    completionModels: normalizeModelAllowlist({
      configured: entry.hasAllowedCompletionModelsConfig === true,
      values: entry.allowedCompletionModels,
    }),
  };
}

export function resolvePluginPolicyId(
  authority: RuntimeLlmAuthority | undefined,
  caller: LlmCompleteCaller,
): string | undefined {
  const authorityPluginId = normalizeOptionalString(authority?.pluginIdForPolicy);
  if (authorityPluginId) {
    return authorityPluginId;
  }
  if (caller.kind !== "plugin") {
    return undefined;
  }
  const pluginId = normalizeOptionalString(caller.id);
  return pluginId;
}

export function resolvePluginLlmPolicy(
  cfg: OpenClawConfig,
  pluginId: string | undefined,
): RuntimeLlmPolicy | undefined {
  if (!pluginId) {
    return undefined;
  }
  const entry = normalizePluginsConfig(cfg.plugins).entries[pluginId]?.llm;
  return entry ? buildPolicyFromEntry(entry) : undefined;
}

export function resolveAuthorityModelPolicy(
  authority?: RuntimeLlmAuthority,
): RuntimeLlmPolicy | undefined {
  if (
    authority?.allowAgentIdOverride !== true &&
    authority?.allowModelOverride !== true &&
    authority?.allowAuthProfileOverride !== true &&
    authority?.allowedModels === undefined &&
    authority?.allowedCompletionModels === undefined
  ) {
    return undefined;
  }
  return buildPolicyFromEntry({
    allowAgentIdOverride: authority.allowAgentIdOverride,
    allowModelOverride: authority.allowModelOverride,
    allowAuthProfileOverride: authority.allowAuthProfileOverride,
    hasAllowedModelsConfig: authority.allowedModels !== undefined,
    allowedModels: authority.allowedModels,
    hasAllowedCompletionModelsConfig: authority.allowedCompletionModels !== undefined,
    allowedCompletionModels: authority.allowedCompletionModels,
  });
}

function assertOverrideModelAllowed(params: {
  resolvedModelRef: string | null;
  policy: RuntimeLlmPolicy | undefined;
  policyOwnerPluginId?: string;
}): void {
  const allowlist = params.policy?.overrideModels;
  if (!allowlist?.configured) {
    return;
  }
  if (allowlist.allowAny) {
    return;
  }
  if (allowlist.models.size === 0) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion model override allowlist has no valid models.",
    );
  }
  if (!params.resolvedModelRef) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion model override allowlist requires a resolvable provider/model target.",
    );
  }
  if (!allowlist.models.has(params.resolvedModelRef)) {
    const owner = params.policyOwnerPluginId ? ` for plugin "${params.policyOwnerPluginId}"` : "";
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      `Plugin LLM completion model override "${params.resolvedModelRef}" is not allowlisted${owner}.`,
    );
  }
}

export function assertAllowedModelOverride(params: {
  resolvedModelRef: string | null;
  pluginPolicyId: string | undefined;
  authorityPolicy: RuntimeLlmPolicy | undefined;
  pluginPolicy: RuntimeLlmPolicy | undefined;
}): void {
  if (
    params.authorityPolicy?.allowModelOverride !== true &&
    params.pluginPolicy?.allowModelOverride !== true
  ) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion cannot override the target model.",
    );
  }
  // Host and operator policy are independent trust boundaries. When both
  // configure a restriction, an override must satisfy their intersection.
  assertOverrideModelAllowed({
    resolvedModelRef: params.resolvedModelRef,
    policy: params.authorityPolicy,
  });
  assertOverrideModelAllowed({
    resolvedModelRef: params.resolvedModelRef,
    policy: params.pluginPolicy,
    policyOwnerPluginId: params.pluginPolicyId,
  });
}

export function assertCompletionModelAllowed(params: {
  resolvedModelRef: string | null;
  policy: RuntimeLlmPolicy | undefined;
  policyOwnerPluginId?: string;
}): void {
  const policy = params.policy;
  const allowlist = policy?.completionModels;
  if (!allowlist?.configured) {
    return;
  }
  if (allowlist.allowAny) {
    return;
  }
  if (allowlist.models.size === 0) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion model allowlist has no valid models.",
    );
  }
  if (!params.resolvedModelRef) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion model allowlist requires a resolvable provider/model target.",
    );
  }
  if (!allowlist.models.has(params.resolvedModelRef)) {
    const owner = params.policyOwnerPluginId ? ` for plugin "${params.policyOwnerPluginId}"` : "";
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      `Plugin LLM completion model "${params.resolvedModelRef}" is not allowlisted for completions${owner}.`,
    );
  }
}
