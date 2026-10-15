import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPlatformClawSkillHubClient } from "./src/client.js";
import { registerPlatformClawSkillHubCommand } from "./src/command.js";
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
      registerPlatformClawSkillHubCommand(api, client);
    }
  },
});
