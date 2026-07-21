/**
 * Admin HTTP RPC plugin entry. It exposes a trusted gateway-authenticated HTTP
 * endpoint for the explicit admin method allowlist.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  handleEmployeeProfileSeed,
  loadEmployeeProfilePromptContext,
  PLATFORMCLAW_PROFILE_SEED_METHOD,
  PLATFORMCLAW_PROFILE_STORE_NAMESPACE,
} from "./src/employee-profile.js";
import { handleAdminHttpRpcRequest } from "./src/handler.js";

// Matches the SDK's per-plugin row ceiling. Reject-new preserves immutable
// identity claims instead of evicting a still-active employee profile.
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
    api.registerGatewayMethod(
      PLATFORMCLAW_PROFILE_SEED_METHOD,
      async (options) => await handleEmployeeProfileSeed(options, employeeProfiles),
      { scope: "operator.admin" },
    );
    api.on("before_prompt_build", async (_event, context) => {
      const prependContext = await loadEmployeeProfilePromptContext(
        employeeProfiles,
        context.agentId,
      );
      return prependContext ? { prependContext } : undefined;
    });
  },
});
