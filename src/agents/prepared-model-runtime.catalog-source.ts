import fs from "node:fs";
import path from "node:path";
import { ensureOpenClawModelsJson, planOpenClawModelsJsonSource } from "./models-config.js";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeWorkspaceFacts,
} from "./prepared-model-runtime.facts.js";
import { withPreparedModelRuntimeScope } from "./prepared-model-runtime.plugin-context.js";
import type { PreparedModelRuntimeCatalogMode } from "./prepared-model-runtime.types.js";

const MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;

export type PreparedModelRuntimeCatalogSource = Readonly<{
  modelsJsonContents: string | null;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
}>;

export function captureModelsJsonContents(agentDir: string): string | null {
  try {
    return fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function prepareAgentCatalogSource(
  agentFacts: PreparedModelRuntimeAgentFacts,
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts,
  catalogMode: PreparedModelRuntimeCatalogMode,
  persist = true,
  sourceOptions: { providerDiscoveryProviderIds?: readonly string[] } = {},
): Promise<PreparedModelRuntimeCatalogSource> {
  const { env, input, providerIds } = agentFacts;
  return await withPreparedModelRuntimeScope(
    {
      config: input.config,
      workspaceDir: input.workspaceDir,
      metadataSnapshot: workspaceFacts.pluginMetadataSnapshot,
      pluginRegistry: workspaceFacts.pluginRegistry,
    },
    async () => {
      const options = {
        pluginMetadataSnapshot: workspaceFacts.pluginMetadataSnapshot,
        ...(workspaceFacts.preparedStaticProviderCatalog
          ? { preparedStaticProviderCatalog: workspaceFacts.preparedStaticProviderCatalog }
          : {}),
        ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
        ...(input.env ? { env } : {}),
        ...(catalogMode === "static"
          ? {
              providerDiscoveryEntriesOnly: true as const,
              providerDiscoveryProviderIds:
                sourceOptions.providerDiscoveryProviderIds ?? providerIds,
            }
          : {
              providerDiscoveryTimeoutMs: MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS,
              ...(sourceOptions.providerDiscoveryProviderIds
                ? { providerDiscoveryProviderIds: sourceOptions.providerDiscoveryProviderIds }
                : {}),
            }),
      };
      if (!persist) {
        const source = await planOpenClawModelsJsonSource(input.config, input.agentDir, options);
        return {
          modelsJsonContents: source.modelsJsonContents,
          pluginCatalogs: source.pluginCatalogs,
        };
      }
      if (!input.readOnly) {
        await ensureOpenClawModelsJson(input.config, input.agentDir, options);
      }
      // Capture immediately after the serialized write. Another owner may share this directory and
      // publish a different workspace generation before full-catalog parsing begins.
      return {
        modelsJsonContents: captureModelsJsonContents(input.agentDir),
        pluginCatalogs: loadPersistedPluginModelCatalogsReadOnly(input.agentDir),
      };
    },
    { env },
  );
}
