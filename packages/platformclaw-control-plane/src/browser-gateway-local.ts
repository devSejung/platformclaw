import type {
  BrowserGatewayAccess,
  BrowserGatewayProxyOptions,
  BrowserGatewayProxyErrorCode,
} from "./browser-gateway-contracts.js";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import { requestBrowserOrganizationKnowledge } from "./browser-gateway-knowledge.js";
import { requestBrowserOrganizationMemoryLifecycle } from "./browser-gateway-memory-lifecycle.js";
import { requestBrowserOrganizationMemoryGet } from "./browser-gateway-memory.js";
import { requestBrowserOrganizationMemoryGraph } from "./browser-gateway-organization-graph.js";
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
    const knowledge = await requestBrowserOrganizationKnowledge({
      store: options.organizationKnowledgeStore,
      service: options.organizationKnowledgeService,
      agentId: access.binding.agentId,
      method,
      request,
      now: (options.now ?? Date.now)(),
    });
    if (knowledge.handled) {
      return knowledge;
    }
    const graph = await requestBrowserOrganizationMemoryGraph({
      method,
      request,
      agentId: access.binding.agentId,
      get: options.getOrganizationMemoryGraph?.bind(options),
    });
    if (graph.handled) {
      return graph;
    }
    const memory = await requestBrowserOrganizationMemoryGet({
      method,
      request,
      agentId: access.binding.agentId,
      get: options.getOrganizationMemory?.bind(options),
    });
    if (memory.handled) {
      return memory;
    }
    const lifecycle = await requestBrowserOrganizationMemoryLifecycle({
      lifecycle: options.organizationMemoryLifecycle,
      agentId: access.binding.agentId,
      method,
      request,
      now: (options.now ?? Date.now)(),
    });
    if (
      lifecycle.handled &&
      method === "platformclaw.memory.promotion.submit" &&
      options.organizationKnowledgeService &&
      typeof lifecycle.result === "object" &&
      lifecycle.result !== null &&
      "id" in lifecycle.result &&
      typeof lifecycle.result.id === "string"
    ) {
      const relatedKnowledgeComparison = await options.organizationKnowledgeService
        .comparePromotion({ agentId: access.binding.agentId, requestId: lifecycle.result.id })
        .catch(() => ({
          status: "unavailable",
          reason: "Submission was accepted; related comparison is unavailable.",
        }));
      return { handled: true, result: { ...lifecycle.result, relatedKnowledgeComparison } };
    }
    return lifecycle;
  } catch (error) {
    if (error instanceof BrowserGatewayProxyError) {
      await auditDenied(error.code);
    }
    throw error;
  }
}
