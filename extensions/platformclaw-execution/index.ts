import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createPlatformClawExecutionBackendFactory,
  createPlatformClawExecutionSkillProvider,
  createPlatformClawExecutionSkillInstallProvider,
  createPlatformClawExecutionSkillWorkshopProvider,
  createPlatformClawExecutionTerminalProvider,
  createUnavailableExecutionDependencies,
  PLATFORMCLAW_EXECUTION_BACKEND_ID,
} from "./src/backend.js";
import { registerPlatformClawExecutionGateway } from "./src/gateway.js";
import { createExecutionDependenciesFromEnvironment } from "./src/runtime.js";
import { PlatformClawTargetMutationCoordinator } from "./src/target-mutation-coordinator.js";

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
    const logTiming = (message: string) => api.logger.info(message);
    const executionRuntimePromise = configured
      ? createExecutionDependenciesFromEnvironment(process.env, { logTiming })
      : undefined;
    const dependenciesPromise =
      executionRuntimePromise ?? Promise.resolve(createUnavailableExecutionDependencies());
    const targetMutations = new PlatformClawTargetMutationCoordinator();
    registerSandboxBackend(PLATFORMCLAW_EXECUTION_BACKEND_ID, {
      factory: async (params) =>
        await createPlatformClawExecutionBackendFactory(await dependenciesPromise, {
          logTiming,
        })(params),
      skillMaterialization: "backend-deferred",
      skills: async (params) =>
        await createPlatformClawExecutionSkillProvider(await dependenciesPromise)(params),
      skillInstall: async (params) =>
        await createPlatformClawExecutionSkillInstallProvider(
          await dependenciesPromise,
          targetMutations,
        )(params),
      skillWorkshop: async (params) =>
        await createPlatformClawExecutionSkillWorkshopProvider(await dependenciesPromise)(params),
      terminal: async (params) =>
        await createPlatformClawExecutionTerminalProvider(
          await dependenciesPromise,
          targetMutations,
        )(params),
    });
    if (!executionRuntimePromise) {
      return;
    }
    api.on("gateway_stop", async () => {
      await (await executionRuntimePromise).dispose();
    });
    registerPlatformClawExecutionGateway(api, executionRuntimePromise, targetMutations);
  },
});
