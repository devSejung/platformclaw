// Provider-only preparation is loaded only by this explicit, agent-free capability.
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { normalizeUsage } from "../../agents/usage.js";
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
  type CreateRuntimeLlmOptions,
} from "./runtime-llm-completion-common.js";
import type {
  LlmProviderConfigCompleteParams,
  LlmProviderConfigCompleteResult,
} from "./types-core.js";

export async function completeWithProviderConfig(
  params: LlmProviderConfigCompleteParams,
  options: CreateRuntimeLlmOptions,
): Promise<LlmProviderConfigCompleteResult> {
  const caller = resolveTrustedCaller(options.authority);
  if (options.authority?.allowComplete === false) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Provider-config completion is denied by host policy.",
    );
  }
  const cfg = resolveRuntimeConfig(options);
  const pluginPolicyId = resolvePluginPolicyId(options.authority, caller);
  const pluginPolicy = resolvePluginLlmPolicy(cfg, pluginPolicyId);
  const authorityPolicy = resolveAuthorityModelPolicy(options.authority);
  if (
    "agentId" in params ||
    options.authority?.agentId ||
    options.authority?.requiresBoundAgent ||
    options.authority?.sessionKey
  ) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Provider-config completion cannot use an employee agent or session binding.",
    );
  }
  const parsed = parseModelCatalogRef(params.model ?? "");
  if (!parsed || splitTrailingAuthProfile(params.model ?? "").profile) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Provider-config completion requires an explicit model without an auth profile.",
    );
  }
  const resolvedModelRef = modelKey(parsed.provider, parsed.modelId);
  assertCompletionModelAllowed({ resolvedModelRef, policy: authorityPolicy });
  assertCompletionModelAllowed({
    resolvedModelRef,
    policy: pluginPolicy,
    policyOwnerPluginId: pluginPolicyId,
  });
  const configuredDefault = cfg.agents?.defaults?.model;
  const primary =
    typeof configuredDefault === "string" ? configuredDefault : configuredDefault?.primary;
  if (resolvedModelRef !== primary) {
    assertAllowedModelOverride({
      resolvedModelRef,
      pluginPolicyId,
      authorityPolicy,
      pluginPolicy,
    });
  }
  // Denied requests must not materialize provider preparation or its runtime dependencies.
  const [{ prepareProviderConfigCompletionModel }, { completeWithPreparedSimpleCompletionModel }] =
    await Promise.all([
      import("../../agents/provider-config-completion-runtime.js"),
      import("../../agents/simple-completion-runtime.js"),
    ]);
  const prepared = prepareProviderConfigCompletionModel({
    cfg,
    provider: parsed.provider,
    modelId: parsed.modelId,
  });
  const result = await completeWithPreparedSimpleCompletionModel({
    model: prepared.model,
    auth: prepared.auth,
    cfg,
    context: {
      systemPrompt: buildSystemPrompt(params),
      messages: buildMessages({
        request: params,
        provider: parsed.provider,
        model: parsed.modelId,
        api: prepared.model.api,
      }),
    },
    options: {
      maxTokens: finiteOption(params.maxTokens),
      temperature: finiteOption(params.temperature),
      signal: params.signal,
    },
  });
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw completionError(
      "LLM_COMPLETION_FAILED",
      result.errorMessage ??
        "Provider-config completion failed; verify the configured provider credential and endpoint.",
    );
  }
  if (result.provider !== parsed.provider || result.model !== parsed.modelId) {
    throw completionError(
      "LLM_COMPLETION_FAILED",
      "Provider-config completion changed the configured model identity.",
    );
  }
  return {
    text: result.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join(""),
    provider: parsed.provider,
    model: parsed.modelId,
    usage: buildUsage({
      rawUsage: result.usage,
      normalized: normalizeUsage(result.usage),
      cfg,
      provider: parsed.provider,
      model: parsed.modelId,
    }),
    execution: { mode: "direct-provider", owner: { kind: "provider", id: parsed.provider } },
    audit: { caller, ...(params.purpose ? { purpose: params.purpose } : {}) },
  };
}
