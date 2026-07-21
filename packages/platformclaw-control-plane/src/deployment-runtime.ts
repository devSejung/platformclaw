import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import type { PlatformClawDeploymentConfig } from "./deployment-config.js";
import { HttpGatewayAdminRpcClient } from "./gateway-admin-rpc-client.js";
import { GatewayPersonalAgentProvisioner } from "./personal-agent-provisioner.js";
import {
  createPlatformClawWebIngressRuntime,
  type PlatformClawWebIngressRuntime,
  type PlatformClawWebIngressRuntimeOptions,
} from "./web-ingress-runtime.js";

export type PlatformClawDeploymentRuntimeFactory = (
  options: PlatformClawWebIngressRuntimeOptions,
) => PlatformClawWebIngressRuntime;

export type PlatformClawDeploymentRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  createRuntime?: PlatformClawDeploymentRuntimeFactory;
};

function buildPersonalMainSessionKey({ agentId }: { agentId: string }): string {
  if (!isValidAgentId(agentId) || agentId !== agentId.toLowerCase()) {
    throw new Error(`invalid personal agent id: ${agentId}`);
  }
  return `agent:${agentId}:main`;
}

function resolvePersonalAgentId(sessionKey: string): string | null {
  const match = /^agent:([^:]+):/u.exec(sessionKey);
  const agentId = match?.[1];
  if (!agentId || !isValidAgentId(agentId) || agentId !== agentId.toLowerCase()) {
    return null;
  }
  return agentId;
}

/** Assemble the deployable control process without importing OpenClaw core. */
export function createPlatformClawDeploymentRuntime(
  config: PlatformClawDeploymentConfig,
  options: PlatformClawDeploymentRuntimeOptions = {},
): PlatformClawWebIngressRuntime {
  const rpc = new HttpGatewayAdminRpcClient({
    rpcUrl: config.gatewayAdminRpcUrl,
    bearerToken: config.gatewayAuth,
  });
  const provisioner = new GatewayPersonalAgentProvisioner({
    rpc,
    workspaceRoot: config.workspaceRoot,
  });
  const createRuntime = options.createRuntime ?? createPlatformClawWebIngressRuntime;
  return createRuntime({
    databasePath: config.databasePath,
    initialAdminAccountIds: config.initialAdminAccountIds,
    buildAgentMainSessionKey: buildPersonalMainSessionKey,
    resolveAgentIdFromSessionKey: resolvePersonalAgentId,
    provisioner,
    employeeAuth: { env: options.env ?? process.env },
    gatewayClient: {
      client: {
        url: config.gatewayUrl,
        token: config.gatewayAuth,
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: "PlatformClaw Control",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        role: "operator",
      },
    },
    publicOrigin: config.publicOrigin,
    controlUiRoot: config.controlUiRoot,
  });
}
