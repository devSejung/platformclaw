import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createPlatformClawExecutionBackendFactory,
  createPlatformClawExecutionSkillProvider,
  createPlatformClawExecutionSkillWorkshopProvider,
  createUnavailableExecutionDependencies,
  PLATFORMCLAW_EXECUTION_BACKEND_ID,
} from "./src/backend.js";
import { registerPlatformClawExecutionGateway } from "./src/gateway.js";
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
    const executionRuntimePromise = configured
      ? createExecutionDependenciesFromEnvironment()
      : undefined;
    const dependenciesPromise =
      executionRuntimePromise ?? Promise.resolve(createUnavailableExecutionDependencies());
    registerSandboxBackend(PLATFORMCLAW_EXECUTION_BACKEND_ID, {
      factory: async (params) =>
        await createPlatformClawExecutionBackendFactory(await dependenciesPromise)(params),
      skillMaterialization: "backend-deferred",
      skills: async (params) =>
        await createPlatformClawExecutionSkillProvider(await dependenciesPromise)(params),
      skillWorkshop: async (params) =>
        await createPlatformClawExecutionSkillWorkshopProvider(await dependenciesPromise)(params),
    });
    if (!executionRuntimePromise) {
      return;
    }
    registerPlatformClawExecutionGateway(api, executionRuntimePromise);
  },
});
