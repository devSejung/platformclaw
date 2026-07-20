import type { HelloOk } from "@openclaw/gateway-protocol";
import {
  PLATFORMCLAW_WEB_GATEWAY_EVENTS,
  PLATFORMCLAW_WEB_GATEWAY_METHODS,
  type BrowserGatewayAccess,
} from "./browser-gateway-proxy.js";

const BROWSER_OPERATOR_SCOPES = ["operator.read", "operator.write"] as const;

export function projectPlatformClawBrowserHello(params: {
  upstream: HelloOk;
  access: BrowserGatewayAccess;
  connectionId: string;
  maxPayloadBytes?: number;
}): HelloOk {
  const upstreamMethods = new Set(params.upstream.features.methods);
  const upstreamEvents = new Set(params.upstream.features.events);
  return {
    type: "hello-ok",
    protocol: params.upstream.protocol,
    server: {
      version: params.upstream.server.version,
      connId: params.connectionId,
    },
    features: {
      methods: PLATFORMCLAW_WEB_GATEWAY_METHODS.filter((method) => upstreamMethods.has(method)),
      events: PLATFORMCLAW_WEB_GATEWAY_EVENTS.filter((event) => upstreamEvents.has(event)),
      capabilities: [],
    },
    snapshot: {
      presence: [],
      health: {},
      stateVersion: { presence: 0, health: 0 },
      uptimeMs: params.upstream.snapshot.uptimeMs,
      sessionDefaults: {
        defaultAgentId: params.access.binding.agentId,
        mainKey: "main",
        mainSessionKey: params.access.mainSessionKey,
      },
    },
    auth: {
      role: "operator",
      scopes: [...BROWSER_OPERATOR_SCOPES],
    },
    policy: {
      ...params.upstream.policy,
      maxPayload:
        params.maxPayloadBytes === undefined
          ? params.upstream.policy.maxPayload
          : Math.min(params.upstream.policy.maxPayload, params.maxPayloadBytes),
    },
  };
}
