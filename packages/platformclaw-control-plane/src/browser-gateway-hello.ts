import type { HelloOk } from "@openclaw/gateway-protocol";
import {
  PLATFORMCLAW_WEB_ADMIN_METHODS,
  PLATFORMCLAW_WEB_GATEWAY_METHODS,
} from "./browser-gateway-policy.js";
import {
  PLATFORMCLAW_WEB_GATEWAY_EVENTS,
  type BrowserGatewayAccess,
} from "./browser-gateway-proxy.js";

const BROWSER_OPERATOR_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
] as const;
const BROWSER_ADMIN_SCOPES = [...BROWSER_OPERATOR_SCOPES, "operator.admin"] as const;

export function projectPlatformClawBrowserHello(params: {
  upstream: HelloOk;
  access: BrowserGatewayAccess;
  connectionId: string;
  clientInstanceId?: string;
  maxPayloadBytes?: number;
  canvasSurfaceUrl?: string;
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
      methods: PLATFORMCLAW_WEB_GATEWAY_METHODS.filter(
        (method) =>
          (method !== "plugin.surface.refresh" || Boolean(params.canvasSurfaceUrl)) &&
          (method === "commands.list" || upstreamMethods.has(method)) &&
          (params.access.user.globalRole === "admin" ||
            !PLATFORMCLAW_WEB_ADMIN_METHODS.has(method)),
      ),
      events: PLATFORMCLAW_WEB_GATEWAY_EVENTS.filter((event) => upstreamEvents.has(event)),
      capabilities: [],
    },
    snapshot: {
      presence: [
        {
          instanceId: params.clientInstanceId ?? params.connectionId,
          mode: "webchat",
          ts: params.access.user.lastLoginAt ?? params.access.user.updatedAt,
          user: {
            id: params.access.user.id,
            ...(params.access.user.email ? { email: params.access.user.email } : {}),
            name: params.access.user.displayName ?? params.access.user.accountId,
          },
        },
      ],
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
      scopes:
        params.access.user.globalRole === "admin"
          ? [...BROWSER_ADMIN_SCOPES]
          : [...BROWSER_OPERATOR_SCOPES],
    },
    policy: {
      ...params.upstream.policy,
      // Employee browsers have one personal Agent and no cross-user session audience.
      // Do not advertise upstream sharing modes that the BFF intentionally rejects.
      allowedSessionVisibilities: [],
      hasMultipleSessionSharingIdentities: false,
      maxPayload:
        params.maxPayloadBytes === undefined
          ? params.upstream.policy.maxPayload
          : Math.min(params.upstream.policy.maxPayload, params.maxPayloadBytes),
    },
    ...(params.canvasSurfaceUrl ? { pluginSurfaceUrls: { canvas: params.canvasSurfaceUrl } } : {}),
  };
}
