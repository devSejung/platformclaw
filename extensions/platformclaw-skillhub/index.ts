import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPlatformClawSkillHubClient } from "./src/client.js";
import { registerPlatformClawSkillHubCommand } from "./src/command.js";
import { registerSkillHubRunPolicy } from "./src/run-policy.js";
import { registerPlatformClawSkillHubTools } from "./src/tools.js";

export default definePluginEntry({
  id: "platformclaw-skillhub",
  name: "PlatformClaw SkillHub",
  description: "Company SkillHub commands and task-based skill tools for PlatformClaw.",
  register(api) {
    if (!["full", "discovery", "tool-discovery"].includes(api.registrationMode)) {
      return;
    }
    const client = createPlatformClawSkillHubClient();
    registerPlatformClawSkillHubTools(api, client);
    if (api.registrationMode === "full") {
      // The shared service credential setting identifies a configured company deployment.
      // Do not turn installing this plugin alone into a mandatory remote run dependency.
      if (process.env.PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE?.trim()) {
        registerSkillHubRunPolicy(api, client);
      }
      registerPlatformClawSkillHubCommand(api, client);
    }
  },
});
