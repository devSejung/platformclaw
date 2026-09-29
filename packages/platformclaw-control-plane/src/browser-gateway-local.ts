import { requestBrowserBaseball } from "./browser-gateway-baseball.js";
import type {
  BrowserGatewayAccess,
  BrowserGatewayProxyOptions,
  BrowserGatewayProxyErrorCode,
} from "./browser-gateway-contracts.js";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import { projectBrowserSelfUser } from "./browser-gateway-self-service-projections.js";
import { requestBrowserKnowledgeVault } from "./browser-gateway-vault.js";
import { requestBrowserKnowledgeSearch } from "./browser-knowledge-search.js";

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
    const search = await requestBrowserKnowledgeSearch(options, access, method, request);
    if (search.handled) {
      return search;
    }
    const vault = await requestBrowserKnowledgeVault({
      service: options.vaultService,
      access,
      method,
      request,
    });
    if (vault.handled) {
      return vault;
    }
    const baseball = await requestBrowserBaseball({
      store: options.baseballStore,
      userId: access.user.id,
      method,
      request,
    });
    if (baseball.handled) {
      return baseball;
    }
    return { handled: false };
  } catch (error) {
    if (error instanceof BrowserGatewayProxyError) {
      await auditDenied(error.code);
    }
    throw error;
  }
}
