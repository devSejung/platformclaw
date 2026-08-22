import type {
  BrowserGatewayAccess,
  BrowserGatewayProxyOptions,
} from "./browser-gateway-contracts.js";
import { requestBrowserOrganizationMemoryLifecycle } from "./browser-gateway-memory-lifecycle.js";
import { projectBrowserSelfUser } from "./browser-gateway-self-service-projections.js";

type JsonObject = Record<string, unknown>;

/** Resolves BFF-owned RPCs that never dispatch to the private Gateway. */
export async function requestBrowserGatewayLocal(
  options: BrowserGatewayProxyOptions,
  access: BrowserGatewayAccess,
  method: string,
  request: JsonObject,
): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (method === "users.self") {
    return { handled: true, result: projectBrowserSelfUser(access.user) };
  }
  if (method === "sessions.subscribe") {
    return { handled: true, result: { subscribed: true } };
  }
  return await requestBrowserOrganizationMemoryLifecycle({
    lifecycle: options.organizationMemoryLifecycle,
    agentId: access.binding.agentId,
    method,
    request,
    now: (options.now ?? Date.now)(),
  });
}
