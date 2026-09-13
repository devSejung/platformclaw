import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import type { Model } from "../llm/types.js";
import { resolveConfiguredFallbackModel } from "./embedded-agent-runner/model.configured-fallback.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import {
  resolveProviderConfig,
  resolveUsableCustomProviderApiKey,
} from "./model-auth-provider-config.js";
import {
  assertRuntimeProviderSecretOwnerAvailable,
  resolveManagedSecretRefRuntimeProviderAuth,
} from "./model-auth-runtime-config.js";
import { applySecretRefHeaderSentinels, type ResolvedProviderAuth } from "./model-auth.js";
import { protectPreparedProviderRuntimeAuth } from "./provider-secret-egress.js";

/** Provider-owned service completion must never inspect an employee agent's credential store. */
export function prepareProviderConfigCompletionModel(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
}): { model: Model; auth: ResolvedProviderAuth } {
  const providerConfig = resolveProviderConfig(params.cfg, params.provider);
  const configuredModel = providerConfig?.models?.find((model) => model.id === params.modelId);
  if (
    !providerConfig ||
    !configuredModel ||
    !(configuredModel.baseUrl ?? providerConfig.baseUrl)?.trim()
  ) {
    throw new Error(
      "Provider-config completion requires an explicitly configured model and endpoint.",
    );
  }
  const explicitRef = coerceSecretRef(providerConfig.apiKey);
  if (
    typeof providerConfig.apiKey === "string" &&
    !explicitRef &&
    (isNonSecretApiKeyMarker(providerConfig.apiKey) ||
      params.cfg.auth?.profiles?.[providerConfig.apiKey])
  ) {
    throw new Error(
      "Provider-config completion cannot use credential markers or stored profile references. Configure an explicit provider-entry credential.",
    );
  }
  assertRuntimeProviderSecretOwnerAvailable({ cfg: params.cfg, provider: params.provider });
  const managedAuth = resolveManagedSecretRefRuntimeProviderAuth({
    cfg: params.cfg,
    provider: params.provider,
    secretSentinels: true,
  });
  const customAuth = managedAuth
    ? null
    : resolveUsableCustomProviderApiKey({
        cfg: params.cfg,
        provider: params.provider,
        secretSentinels: true,
      });
  const auth =
    managedAuth ??
    (customAuth
      ? {
          apiKey: customAuth.apiKey,
          source: customAuth.source,
          mode: "api-key" as const,
        }
      : undefined);
  if (!auth?.apiKey || !providerConfig.apiKey) {
    throw new Error(
      "Provider-config completion requires a ready provider-entry apiKey or explicit SecretRef. Configure that provider credential; employee profiles and implicit environment credentials are excluded.",
    );
  }
  const model = resolveConfiguredFallbackModel({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    manifestAlias: { provider: params.provider },
  });
  if (!model || model.provider !== params.provider || model.id !== params.modelId) {
    throw new Error("Provider-config completion could not resolve the exact configured model.");
  }
  const protectedAuth = protectPreparedProviderRuntimeAuth({
    provider: params.provider,
    preparedAuth: { apiKey: auth.apiKey },
  });
  return {
    model: applySecretRefHeaderSentinels(model, params.cfg),
    auth: { ...auth, apiKey: protectedAuth?.apiKey ?? auth.apiKey },
  };
}
