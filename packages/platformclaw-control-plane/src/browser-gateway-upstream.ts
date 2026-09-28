import type { BrowserGatewayProxyOptions } from "./browser-gateway-contracts.js";
import { recoverMissingBrowserMemoryResult } from "./browser-gateway-memory.js";

type JsonObject = Record<string, unknown>;

/** Owns browser-method aliases and post-fetch enrichment for ordinary Gateway RPC. */
export async function requestBrowserGatewayUpstream(params: {
  gateway: BrowserGatewayProxyOptions["gateway"];
  method: string;
  request: JsonObject;
  agentId: string;
}): Promise<unknown> {
  const upstreamMethod = params.method === "commands.list" ? "chat.metadata" : params.method;
  const upstreamParams =
    params.method === "commands.list" ? { agentId: params.request.agentId } : params.request;
  try {
    return await params.gateway.request(upstreamMethod, upstreamParams);
  } catch (error) {
    const recovered = recoverMissingBrowserMemoryResult({ ...params, error });
    if (recovered !== undefined) {
      return recovered;
    }
    throw error;
  }
}
