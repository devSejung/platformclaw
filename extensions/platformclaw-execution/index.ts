import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createPlatformClawExecutionBackendFactory,
  createUnavailableExecutionDependencies,
  PLATFORMCLAW_EXECUTION_BACKEND_ID,
} from "./src/backend.js";

export default definePluginEntry({
  id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
  name: "PlatformClaw Execution",
  description: "Private execution-target router for PlatformClaw personal agents.",
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    registerSandboxBackend(
      PLATFORMCLAW_EXECUTION_BACKEND_ID,
      createPlatformClawExecutionBackendFactory(createUnavailableExecutionDependencies()),
    );
  },
});
