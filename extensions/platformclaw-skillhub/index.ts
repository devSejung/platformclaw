import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerPlatformClawSkillHubCommand } from "./src/command.js";

export default definePluginEntry({
  id: "platformclaw-skillhub",
  name: "PlatformClaw SkillHub",
  description: "Company SkillHub commands for PlatformClaw.",
  register(api) {
    if (api.registrationMode === "full") {
      registerPlatformClawSkillHubCommand(api);
    }
  },
});
