/**
 * Admin HTTP RPC plugin entry. It exposes a trusted gateway-authenticated HTTP
 * endpoint for the explicit admin method allowlist.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  handleAgentConfigStatus,
  PLATFORMCLAW_AGENT_CONFIG_STATUS_METHOD,
} from "./src/agent-runtime-status.js";
import {
  handleEmployeeProfileSeed,
  handleEmployeeProfileStatus,
  loadEmployeeProfilePromptContext,
  PLATFORMCLAW_PROFILE_SEED_METHOD,
  PLATFORMCLAW_PROFILE_STATUS_METHOD,
  PLATFORMCLAW_PROFILE_STORE_NAMESPACE,
} from "./src/employee-profile.js";
import { handleAdminHttpRpcRequest } from "./src/handler.js";
import { PLATFORMCLAW_PRODUCT_SYSTEM_CONTEXT } from "./src/product-identity.js";

// Matches the SDK's per-plugin row ceiling. Reject-new preserves active
// employee ownership instead of evicting a profile during mutable refresh.
const MAX_EMPLOYEE_PROFILES = 50_000;

export default definePluginEntry({
  id: "admin-http-rpc",
  name: "Admin HTTP RPC",
  description: "Expose selected admin RPC and PlatformClaw profile context",
  register(api) {
    const employeeProfiles = api.runtime.state.openKeyedStore<unknown>({
      namespace: PLATFORMCLAW_PROFILE_STORE_NAMESPACE,
      maxEntries: MAX_EMPLOYEE_PROFILES,
      overflowPolicy: "reject-new",
    });
    api.registerHttpRoute({
      path: "/api/v1/admin/rpc",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: handleAdminHttpRpcRequest,
    });
    api.registerGatewayMethod(PLATFORMCLAW_AGENT_CONFIG_STATUS_METHOD, handleAgentConfigStatus, {
      scope: "operator.admin",
    });
    api.registerGatewayMethod(
      PLATFORMCLAW_PROFILE_SEED_METHOD,
      async (options) => await handleEmployeeProfileSeed(options, employeeProfiles),
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      PLATFORMCLAW_PROFILE_STATUS_METHOD,
      async (options) => await handleEmployeeProfileStatus(options, employeeProfiles),
      { scope: "operator.admin" },
    );
    api.on("before_prompt_build", async (_event, context) => {
      const prependContext = await loadEmployeeProfilePromptContext(
        employeeProfiles,
        context.agentId,
      );
      return {
        appendSystemContext: PLATFORMCLAW_PRODUCT_SYSTEM_CONTEXT,
        ...(prependContext ? { prependContext } : {}),
      };
    });
  },
});
