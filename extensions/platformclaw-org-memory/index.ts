import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerOrganizationKnowledgeAnalysis } from "./src/analysis-gateway.js";
import { createOrganizationMemoryClient } from "./src/client.js";
import { createOrganizationMemorySupplement } from "./src/supplement.js";
import { createVaultTurnScopeController } from "./src/turn-scope.js";

export default definePluginEntry({
  id: "platformclaw-org-memory",
  name: "PlatformClaw Organization Memory",
  description: "Authorized Team, Group, Part, and Global memory corpus for personal agents.",
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    registerOrganizationKnowledgeAnalysis(api);
    const client = createOrganizationMemoryClient(process.env);
    if (!client) {
      api.logger.warn(
        "platformclaw-org-memory: organization search is not configured; managed memory_search will report it unavailable",
      );
    }
    const turnScope = client ? createVaultTurnScopeController(api, client) : undefined;
    if (turnScope) {
      // All tool-capable harnesses await this hook; some do not emit agent_turn_prepare.
      api.on("before_prompt_build", async (_event, context) => {
        await turnScope.prepare(context);
      });
    }
    api.registerMemoryCorpusSupplement(
      createOrganizationMemorySupplement(client, api.logger, turnScope?.get),
    );
    api.registerMemoryPromptSupplement(({ availableTools }) =>
      client && availableTools.has("memory_search")
        ? [
            "Search Personal knowledge and connected Shared/Managed vaults by default using short distinctive keywords. Connection changes apply next turn. Only for an explicitly selected vault, use its returned vaultId or exact Shared/Managed vaultName, never both. Ask the user to choose ambiguous names; never guess a vault or backend. Personal content is shared only by explicit publication or copying. Cite the vault name and document version.",
          ]
        : [],
    );
  },
});
