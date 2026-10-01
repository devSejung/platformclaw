import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createWikiHubMemoryClient } from "./src/client.js";
import { registerSpaceTools } from "./src/space-tools.js";
import { createWikiHubCorpusSupplement } from "./src/supplement.js";
import { createVaultTurnScopeController } from "./src/turn-scope.js";

export default definePluginEntry({
  // Deployment pins this internal ID in docker/platformclaw-runtime/openclaw.initial.json.
  // Retaining it does not retain the retired Organization knowledge APIs or data.
  id: "platformclaw-org-memory",
  name: "PlatformClaw Wiki Hub",
  description: "Authorized Shared Wiki operations and per-turn Wiki selection.",
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const client = createWikiHubMemoryClient(process.env);
    if (!client) {
      api.logger.warn(
        "platformclaw-org-memory: Wiki Hub is not configured; Shared operations will report it unavailable",
      );
    }
    if (client) {
      registerSpaceTools(api, client);
    }
    const turnScope = client ? createVaultTurnScopeController(api, client) : undefined;
    if (turnScope) {
      // All tool-capable harnesses await this hook; some do not emit agent_turn_prepare.
      api.on("before_prompt_build", async (_event, context) => {
        if (!/^space-[a-f0-9-]{36}$/u.test(context.agentId ?? "")) {
          await turnScope.prepare(context);
        }
      });
    }
    api.registerMemoryCorpusSupplement(
      createWikiHubCorpusSupplement(client, api.logger, turnScope?.get, turnScope?.resolve),
    );
    api.registerMemoryPromptSupplement(({ availableTools }) =>
      client && availableTools.has("memory_search")
        ? [
            "Search automatic Memory and enabled Personal/Shared Wikis by default using short distinctive keywords. Connection changes apply next turn. Only for an explicitly selected vault, use its returned vaultId or exact Shared vaultName, never both. Ask the user to choose ambiguous names; never guess a vault or backend. Personal content is shared only by explicit publication or copying. Cite the vault name and document version.",
          ]
        : [],
    );
  },
});
