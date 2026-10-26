/**
 * Built-in model suppression helpers.
 * Resolves plugin manifest suppression rules with process-local caching so
 * built-in catalog entries can be hidden or blocked consistently.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "../../packages/normalization-core/src/string-coerce.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { buildManifestBuiltInModelSuppressionResolver } from "../plugins/manifest-model-suppression.js";
import { resolvePluginControlPlaneFingerprint } from "../plugins/plugin-control-plane-context.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataEnvFingerprint } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

type ManifestSuppressionResolver = ReturnType<typeof buildManifestBuiltInModelSuppressionResolver>;

type CachedManifestSuppressionResolver = {
  config: OpenClawConfig | undefined;
  controlPlaneFingerprint: string;
  cwd: string;
  envFingerprint: string;
  metadataSnapshot: PluginMetadataSnapshot | undefined;
  resolver: ManifestSuppressionResolver;
  workspaceDir: string | undefined;
};

let cachedManifestSuppressionResolver: CachedManifestSuppressionResolver | undefined;

/** Clear cached manifest suppression resolver state for tests and metadata lifecycle resets. */
function clearModelSuppressionResolverCache(): void {
  cachedManifestSuppressionResolver = undefined;
}

registerPluginMetadataProcessMemoLifecycleClear(clearModelSuppressionResolverCache);

function resolveCachedManifestSuppressionResolver(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): ManifestSuppressionResolver {
  const cached = cachedManifestSuppressionResolver;
  const controlPlaneFingerprint = resolvePluginControlPlaneFingerprint({
    ...(params.config ? { config: params.config } : {}),
    env: params.env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  const cwd = process.cwd();
  const envFingerprint = resolvePluginMetadataEnvFingerprint(params.env);
  // The same config can be leased by concurrent owner generations. Cache the
  // effective scoped snapshot, never the unrelated Gateway-global generation.
  const metadataSnapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    allowWorkspaceScopedSnapshot: params.workspaceDir === undefined,
  });
  if (
    cached !== undefined &&
    cached.config === params.config &&
    cached.controlPlaneFingerprint === controlPlaneFingerprint &&
    cached.cwd === cwd &&
    cached.envFingerprint === envFingerprint &&
    cached.metadataSnapshot === metadataSnapshot &&
    cached.workspaceDir === params.workspaceDir
  ) {
    return cached.resolver;
  }
  const resolver = buildManifestBuiltInModelSuppressionResolver({
    env: params.env,
    ...(metadataSnapshot ? { metadataSnapshot } : {}),
    ...(params.config ? { config: params.config } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  cachedManifestSuppressionResolver = {
    config: params.config,
    controlPlaneFingerprint,
    cwd,
    envFingerprint,
    metadataSnapshot,
    resolver,
    workspaceDir: params.workspaceDir,
  };
  return resolver;
}

function resolveBuiltInModelSuppressionFromManifest(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
  unconditionalOnly?: boolean;
  workspaceDir?: string;
}) {
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = normalizeLowercaseStringOrEmpty(params.id);
  if (!provider || !modelId) {
    return undefined;
  }
  return resolveCachedManifestSuppressionResolver({
    env: process.env,
    ...(params.config ? { config: params.config } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  })({
    provider,
    id: modelId,
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    ...(params.unconditionalOnly !== undefined
      ? { unconditionalOnly: params.unconditionalOnly }
      : {}),
  });
}

function resolveBuiltInModelSuppression(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
}) {
  const manifestResult = resolveBuiltInModelSuppressionFromManifest(params);
  if (manifestResult?.suppress) {
    return manifestResult;
  }
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = normalizeLowercaseStringOrEmpty(params.id);
  if (!provider || !modelId) {
    return undefined;
  }
  return undefined;
}

/** Return true when plugin manifest metadata suppresses a built-in model entry. */
export function shouldSuppressBuiltInModelFromManifest(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
}) {
  return resolveBuiltInModelSuppressionFromManifest(params)?.suppress ?? false;
}

/** Return true when any built-in suppression rule applies to a model entry. */
export function shouldSuppressBuiltInModel(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
}) {
  return resolveBuiltInModelSuppression(params)?.suppress ?? false;
}

/**
 * Return true only for unconditional manifest suppressions.
 * Inline model entries may override conditional suppressions, but not absolute
 * provider capability blocks.
 */
export function shouldUnconditionallySuppress(params: {
  provider?: string | null;
  id?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): boolean {
  return (
    resolveBuiltInModelSuppressionFromManifest({ ...params, unconditionalOnly: true })?.suppress ??
    false
  );
}

/** Resolve the user-facing suppression error message for a built-in model. */
export function buildSuppressedBuiltInModelError(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string | undefined {
  return resolveBuiltInModelSuppression(params)?.errorMessage;
}

/** Build a reusable suppression predicate for repeated catalog filtering. */
export function buildShouldSuppressBuiltInModel(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): (input: { provider?: string | null; id?: string | null; baseUrl?: string | null }) => boolean {
  const resolver = buildManifestBuiltInModelSuppressionResolver({
    env: params.env ?? process.env,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    ...(params.config ? { config: params.config } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });

  return (input) => {
    const provider = normalizeProviderId(input.provider ?? "");
    const id = normalizeLowercaseStringOrEmpty(input.id);
    if (!provider || !id) {
      return false;
    }
    return (
      resolver({
        provider,
        id,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      })?.suppress ?? false
    );
  };
}
