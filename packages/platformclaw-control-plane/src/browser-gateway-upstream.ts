import type { BrowserGatewayProxyOptions } from "./browser-gateway-contracts.js";
import {
  appendOrganizationMemorySearch,
  recoverMissingBrowserMemoryResult,
} from "./browser-gateway-memory.js";

type JsonObject = Record<string, unknown>;

/** Owns browser-method aliases and post-fetch enrichment for ordinary Gateway RPC. */
export async function requestBrowserGatewayUpstream(params: {
  gateway: BrowserGatewayProxyOptions["gateway"];
  method: string;
  request: JsonObject;
  agentId: string;
  searchOrganizationMemory: BrowserGatewayProxyOptions["searchOrganizationMemory"];
}): Promise<unknown> {
  const upstreamMethod = params.method === "commands.list" ? "chat.metadata" : params.method;
  const upstreamParams =
    params.method === "commands.list" ? { agentId: params.request.agentId } : params.request;
  try {
    return await appendOrganizationMemorySearch(
      params.method,
      await params.gateway.request(upstreamMethod, upstreamParams),
      params.agentId,
      typeof params.request.query === "string" ? params.request.query : "",
      params.searchOrganizationMemory,
    );
  } catch (error) {
    const recovered = recoverMissingBrowserMemoryResult({ ...params, error });
    if (recovered !== undefined) {
      return recovered;
    }
    throw error;
  }
}
