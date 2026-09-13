// Runtime LLM helpers adapt plugin provider hooks into the core model runtime.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { normalizeModelRef } from "../../agents/model-ref-shared.js";
import type { UsageLike } from "../../agents/usage.js";
import { normalizeUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getChildLogger } from "../../logging.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { modelKey } from "../../shared/model-key.js";
import {
  completionError,
  resolveTrustedCaller,
  resolveRuntimeConfig,
  buildSystemPrompt,
  buildMessages,
  buildUsage,
  finiteOption,
  resolvePluginPolicyId,
  resolvePluginLlmPolicy,
  resolveAuthorityModelPolicy,
  assertAllowedModelOverride,
  assertCompletionModelAllowed,
  type RuntimeLlmAuthority,
  type CreateRuntimeLlmOptions,
} from "./runtime-llm-completion-common.js";
import {
  assertSupportedExecutionMode,
  isIsolatedAgentRuntimeRequest,
  runIsolatedAgentRuntimeCompletion,
} from "./runtime-llm-isolated.js";
import type {
  LlmCompleteParams,
  LlmCompleteResult,
  PluginRuntimeCore,
  RuntimeLogger,
} from "./types-core.js";
export type {
  RuntimeLlmAuthority,
  CreateRuntimeLlmOptions,
} from "./runtime-llm-completion-common.js";

const defaultLogger = getChildLogger({ capability: "runtime.llm" });

function toRuntimeLogger(logger: typeof defaultLogger): RuntimeLogger {
  return {
    debug: (message, meta) => logger.debug?.(meta, message),
    info: (message, meta) => logger.info(meta, message),
    warn: (message, meta) => logger.warn(meta, message),
    error: (message, meta) => logger.error(meta, message),
  };
}

async function resolveAgentId(params: {
  request: LlmCompleteParams;
  cfg: OpenClawConfig;
  authority?: RuntimeLlmAuthority;
  allowAgentIdOverride: boolean;
}): Promise<string> {
  const authorityAgentIdRaw = normalizeOptionalString(params.authority?.agentId);
  const requestedAgentIdRaw = normalizeOptionalString(params.request.agentId);
  const authorityAgentId = authorityAgentIdRaw ? normalizeAgentId(authorityAgentIdRaw) : undefined;
  const requestedAgentId = requestedAgentIdRaw ? normalizeAgentId(requestedAgentIdRaw) : undefined;
  if (params.authority?.requiresBoundAgent && !authorityAgentId) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion is not bound to an active session agent.",
    );
  }
  if (authorityAgentId) {
    if (requestedAgentId && requestedAgentId !== authorityAgentId && !params.allowAgentIdOverride) {
      throw completionError(
        "LLM_COMPLETION_NOT_AUTHORIZED",
        "Plugin LLM completion cannot override the active session agent.",
      );
    }
    return authorityAgentId;
  }
  if (requestedAgentId) {
    if (!params.allowAgentIdOverride) {
      throw completionError(
        "LLM_COMPLETION_NOT_AUTHORIZED",
        "Plugin LLM completion cannot override the target agent.",
      );
    }
    return requestedAgentId;
  }
  const { resolveDefaultAgentId } = await import("../../agents/agent-scope.js");
  return resolveDefaultAgentId(params.cfg);
}

function assertAllowedAuthProfileOverride(params: {
  authProfileId: string | undefined;
  authorityPolicy: ReturnType<typeof resolveAuthorityModelPolicy>;
  pluginPolicy: ReturnType<typeof resolveAuthorityModelPolicy>;
}): void {
  if (!params.authProfileId) {
    return;
  }
  if (
    params.authorityPolicy?.allowAuthProfileOverride === true ||
    params.pluginPolicy?.allowAuthProfileOverride === true
  ) {
    return;
  }
  throw completionError(
    "LLM_COMPLETION_NOT_AUTHORIZED",
    "Plugin LLM completion cannot override the auth profile. Enable plugins.entries.<id>.llm.allowAuthProfileOverride to authorize it.",
  );
}

/**
 * Create the host-owned generic LLM completion runtime for trusted plugin callers.
 */
export function createRuntimeLlm(
  options: CreateRuntimeLlmOptions = {},
): Pick<PluginRuntimeCore["llm"], "complete" | "completeWithProviderConfig"> {
  const logger = options.logger ?? toRuntimeLogger(defaultLogger);
  return {
    completeWithProviderConfig: async (params) => {
      // Keep the shipped agent completion import graph independent of provider-only preparation.
      const { completeWithProviderConfig } = await import("./runtime-llm-provider-config.js");
      return completeWithProviderConfig(params, options);
    },
    complete: async (params: LlmCompleteParams): Promise<LlmCompleteResult> => {
      const caller = resolveTrustedCaller(options.authority);
      if (options.authority?.allowComplete === false) {
        const reason = options.authority.denyReason ?? "capability denied";
        logger.warn("plugin llm completion denied", {
          caller,
          purpose: params.purpose,
          reason,
        });
        throw completionError(
          "LLM_COMPLETION_NOT_AUTHORIZED",
          `Plugin LLM completion denied: ${reason}`,
        );
      }
      assertSupportedExecutionMode(params);

      const [
        {
          prepareSimpleCompletionModelForAgent,
          completeWithPreparedSimpleCompletionModel,
          resolveSimpleCompletionSelectionForAgent,
        },
        cfg,
      ] = await Promise.all([
        import("../../agents/simple-completion-runtime.js"),
        Promise.resolve(resolveRuntimeConfig(options)),
      ]);
      const pluginPolicyId = resolvePluginPolicyId(options.authority, caller);
      const pluginPolicy = resolvePluginLlmPolicy(cfg, pluginPolicyId);
      const authorityPolicy = resolveAuthorityModelPolicy(options.authority);
      const preferredProfile = normalizeOptionalString(options.authority?.preferredProfile);
      const agentId = await resolveAgentId({
        request: params,
        cfg,
        authority: options.authority,
        allowAgentIdOverride:
          options.authority?.allowAgentIdOverride === false
            ? false
            : authorityPolicy?.allowAgentIdOverride === true ||
              pluginPolicy?.allowAgentIdOverride === true,
      });
      const requestedModel = normalizeOptionalString(params.model);
      const requestedModelProfile = requestedModel
        ? normalizeOptionalString(splitTrailingAuthProfile(requestedModel).profile)
        : undefined;
      const selection = resolveSimpleCompletionSelectionForAgent({
        cfg,
        agentId,
        modelRef: requestedModel,
      });
      if (!selection) {
        throw completionError("LLM_COMPLETION_FAILED", `No model configured for agent ${agentId}.`);
      }
      const normalizedSelection = normalizeModelRef(selection.provider, selection.modelId);
      const resolvedModelRef = modelKey(normalizedSelection.provider, normalizedSelection.model);
      assertCompletionModelAllowed({ resolvedModelRef, policy: authorityPolicy });
      assertCompletionModelAllowed({
        resolvedModelRef,
        policy: pluginPolicy,
        policyOwnerPluginId: pluginPolicyId,
      });
      if (requestedModel) {
        assertAllowedModelOverride({
          resolvedModelRef,
          pluginPolicyId,
          authorityPolicy,
          pluginPolicy,
        });
      }

      const isolatedRequest = isIsolatedAgentRuntimeRequest(params);
      const executionProfile = isolatedRequest
        ? normalizeOptionalString(params.execution.authProfileId)
        : undefined;
      const modelProfile = normalizeOptionalString(selection.profileId);
      if (executionProfile && requestedModelProfile && executionProfile !== requestedModelProfile) {
        throw completionError(
          "LLM_ISOLATED_INPUT_REJECTED",
          "Isolated completion received conflicting auth profiles in model and execution.authProfileId.",
        );
      }

      if (isolatedRequest) {
        // Direct completions preserve the shipped model@profile contract under model
        // override authority. Isolated credential routing requires separate authority.
        assertAllowedAuthProfileOverride({
          authProfileId: executionProfile ?? requestedModelProfile,
          authorityPolicy,
          pluginPolicy,
        });
        const result = await runIsolatedAgentRuntimeCompletion({
          request: params,
          cfg,
          agentId,
          provider: selection.provider,
          model: selection.modelId,
          // Request-authorized profiles win, then the host/session binding. Only
          // an unbound call may fall back to the agent's configured selection.
          authProfileId:
            executionProfile ?? requestedModelProfile ?? preferredProfile ?? modelProfile,
        });
        const normalizedUsage = normalizeUsage(result.usage as UsageLike | undefined);
        const usage = buildUsage({
          rawUsage: result.usage,
          normalized: normalizedUsage,
          cfg,
          provider: result.provider,
          model: result.model,
        });
        logger.info("plugin llm completion", {
          caller,
          purpose: params.purpose,
          sessionKey: options.authority?.sessionKey,
          agentId,
          provider: result.provider,
          model: result.model,
          executionMode: params.execution.mode,
          executionOwner: result.owner,
          usage,
        });
        return {
          text: result.text,
          provider: result.provider,
          model: result.model,
          agentId,
          usage,
          execution: { mode: params.execution.mode, owner: result.owner },
          audit: {
            caller,
            ...(params.purpose ? { purpose: params.purpose } : {}),
            ...(options.authority?.sessionKey ? { sessionKey: options.authority.sessionKey } : {}),
          },
        };
      }

      const prepared = await prepareSimpleCompletionModelForAgent({
        cfg,
        agentId,
        modelRef: params.model,
        preferredProfile,
        allowBundledStaticCatalogFallback: true,
        allowMissingApiKeyModes: ["aws-sdk"],
        skipAgentDiscovery: true,
      });

      if ("error" in prepared) {
        throw new Error(`Plugin LLM completion failed: ${prepared.error}`);
      }

      const context = {
        systemPrompt: buildSystemPrompt(params),
        messages: buildMessages({
          request: params,
          provider: prepared.model.provider,
          model: prepared.model.id,
          api: prepared.model.api,
        }),
      };

      const result = await completeWithPreparedSimpleCompletionModel({
        model: prepared.model,
        auth: prepared.auth,
        cfg,
        context,
        options: {
          maxTokens: finiteOption(params.maxTokens),
          temperature: finiteOption(params.temperature),
          ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
          signal: params.signal,
        },
      });

      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const normalizedUsage = normalizeUsage(result.usage as UsageLike | undefined);
      const usage = buildUsage({
        rawUsage: result.usage,
        normalized: normalizedUsage,
        cfg,
        provider: prepared.selection.provider,
        model: prepared.selection.modelId,
      });

      logger.info("plugin llm completion", {
        caller,
        purpose: params.purpose,
        sessionKey: options.authority?.sessionKey,
        agentId,
        provider: prepared.selection.provider,
        model: prepared.selection.modelId,
        executionMode: "direct-provider",
        executionOwner: { kind: "provider", id: prepared.selection.provider },
        usage,
      });

      return {
        text,
        provider: prepared.selection.provider,
        model: prepared.selection.modelId,
        agentId,
        usage,
        execution: {
          mode: "direct-provider",
          owner: { kind: "provider", id: prepared.selection.provider },
        },
        audit: {
          caller,
          ...(params.purpose ? { purpose: params.purpose } : {}),
          ...(options.authority?.sessionKey ? { sessionKey: options.authority.sessionKey } : {}),
        },
      };
    },
  };
}
