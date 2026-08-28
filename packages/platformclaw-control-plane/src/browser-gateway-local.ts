import type {
  BrowserGatewayAccess,
  BrowserGatewayProxyOptions,
  BrowserGatewayProxyErrorCode,
} from "./browser-gateway-contracts.js";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import { requestBrowserOrganizationMemoryLifecycle } from "./browser-gateway-memory-lifecycle.js";
import { requestBrowserOrganizationMemoryGet } from "./browser-gateway-memory.js";
import { projectBrowserSelfUser } from "./browser-gateway-self-service-projections.js";

type JsonObject = Record<string, unknown>;

/** Resolves BFF-owned RPCs that never dispatch to the private Gateway. */
export async function requestBrowserGatewayLocal(
  options: BrowserGatewayProxyOptions,
  access: BrowserGatewayAccess,
  method: string,
  request: JsonObject,
  auditDenied: (reason: BrowserGatewayProxyErrorCode) => Promise<void>,
): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (method === "users.self") {
    return { handled: true, result: projectBrowserSelfUser(access.user) };
  }
  if (method === "sessions.subscribe") {
    return { handled: true, result: { subscribed: true } };
  }
  try {
    const memory = await requestBrowserOrganizationMemoryGet({
      method,
      request,
      agentId: access.binding.agentId,
      get: options.getOrganizationMemory?.bind(options),
    });
    if (memory.handled) {
      return memory;
    }
    return await requestBrowserOrganizationMemoryLifecycle({
      lifecycle: options.organizationMemoryLifecycle,
      agentId: access.binding.agentId,
      method,
      request,
      now: (options.now ?? Date.now)(),
    });
  } catch (error) {
    if (error instanceof BrowserGatewayProxyError) {
      await auditDenied(error.code);
    }
    throw error;
  }
}
