import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerOrganizationKnowledgeAnalysis } from "./src/analysis-gateway.js";
import { createOrganizationMemoryClient } from "./src/client.js";
import { createOrganizationMemorySupplement } from "./src/supplement.js";

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
      return;
    }
    api.registerMemoryCorpusSupplement(createOrganizationMemorySupplement(client, api.logger));
    api.registerMemoryPromptSupplement(({ availableTools }) =>
      availableTools.has("memory_search")
        ? [
            "Authorized PlatformClaw organizational memory is available with memory_search corpus=all or corpus=wiki. Global results are company-wide; Team, Group, and Part results are membership-scoped.",
          ]
        : [],
    );
  },
});
