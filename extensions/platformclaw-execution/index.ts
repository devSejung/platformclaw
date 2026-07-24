import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createPlatformClawExecutionBackendFactory,
  createUnavailableExecutionDependencies,
  PLATFORMCLAW_EXECUTION_BACKEND_ID,
} from "./src/backend.js";
import { createExecutionDependenciesFromEnvironment } from "./src/runtime.js";

export default definePluginEntry({
  id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
  name: "PlatformClaw Execution",
  description: "Private execution-target router for PlatformClaw personal agents.",
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const configured =
      process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS &&
      process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE;
    const dependenciesPromise = configured
      ? createExecutionDependenciesFromEnvironment()
      : Promise.resolve(createUnavailableExecutionDependencies());
    registerSandboxBackend(
      PLATFORMCLAW_EXECUTION_BACKEND_ID,
      async (params) =>
        await createPlatformClawExecutionBackendFactory(await dependenciesPromise)(params),
    );
  },
});
