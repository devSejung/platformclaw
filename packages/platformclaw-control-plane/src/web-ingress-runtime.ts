import {
  createEmployeeBrowserAuthRuntime,
  type EmployeeBrowserAuthRuntime,
  type EmployeeBrowserAuthRuntimeOptions,
} from "./browser-auth-runtime.js";
import type { PersonalAgentProvisioner } from "./browser-auth-service.js";
import { PlatformClawBrowserCanvasRelay } from "./browser-canvas-http.js";
import { EmployeeExecutionService } from "./browser-execution-http.js";
import { BrowserGatewayProxy } from "./browser-gateway-proxy.js";
import {
  MemoryBrowserLoginRateLimiter,
  type MemoryBrowserLoginRateLimiterOptions,
} from "./browser-login-rate-limiter.js";
import { McpAdministrationService } from "./browser-mcp-admin-http.js";
import { EmployeeMcpService } from "./browser-mcp-http.js";
import { PlatformClawBrowserMediaRelay } from "./browser-media-http.js";
import { VmAdministrationService } from "./browser-vm-admin-http.js";
import { JiraVocService, type JiraVocConfig } from "./browser-voc-http.js";
import type { MainSessionKeyBuilder } from "./contracts.js";
import {
  deriveExecutionHandoffAddress,
  PlatformClawExecutionHandoffServer,
} from "./execution-handoff-http.js";
import { ExecutionHandoffService } from "./execution-handoff-service.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import {
  PlatformClawGatewayRuntimeClient,
  type PlatformClawGatewayRuntimeClientOptions,
} from "./gateway-runtime-client.js";
import { KnoxRoutingService, type KnoxRoomAgentProvisioner } from "./knox-routing-service.js";
import {
  AgentRestartReconciler,
  type PersonalAgentRestartRecoveryProbe,
  type RestartReconciliationSummary,
} from "./restart-reconciler.js";
import type { SkillHubAdapter } from "./skill-hub-adapter.js";
import type { SkillHubGovernanceClient } from "./skill-hub-governance-client.js";
import { SkillHubService } from "./skill-hub-service.js";
import { SshCredentialBroker } from "./ssh-credential-broker.js";
import { createPlatformClawWebAssetHandler } from "./web-assets.js";
import {
  PlatformClawWebIngressServer,
  type PlatformClawWebIngressListenOptions,
  type PlatformClawWebIngressOptions,
} from "./web-ingress-server.js";

export type PlatformClawWebIngressRuntimeOptions = {
  databasePath: string;
  initialAdminAccountIds: readonly string[];
  buildAgentMainSessionKey: MainSessionKeyBuilder;
  resolveAgentIdFromSessionKey(sessionKey: string): string | null;
  provisioner: PersonalAgentProvisioner;
  restartRecoveryProbe: PersonalAgentRestartRecoveryProbe;
  employeeAuth?: Pick<
    EmployeeBrowserAuthRuntimeOptions,
    | "employeeAuthConfig"
    | "env"
    | "fetchImpl"
    | "now"
    | "tokenFactory"
    | "sshCredentialCipher"
    | "mcpCredentialCipher"
  >;
  gatewayClient: PlatformClawGatewayRuntimeClientOptions;
  mediaGateway?: {
    origin: string;
    auth: string;
    fetchImpl?: typeof fetch;
  };
  adminRpc: GatewayAdminRpc;
  publicOrigin: string;
  controlUiRoot: string;
  jiraVoc?: JiraVocConfig;
  loginRateLimiter?: MemoryBrowserLoginRateLimiterOptions;
  credentialBrokerAddress?: string;
  executionServiceToken?: string;
  knoxRouting?: {
    serviceToken: string;
    roomProvisioner: KnoxRoomAgentProvisioner;
  };
  knoxIngressProxyUrl?: string;
  skillHub?: {
    adapter: SkillHubAdapter;
    workspaceRoot: string;
    allowedNamespaces: readonly string[];
    namespaceAccessGroups: Readonly<Record<string, string>>;
    maxPackageBytes: number;
    governance: SkillHubGovernanceClient;
    primaryAdminUserId: string;
  };
  ingress?: Pick<
    PlatformClawWebIngressOptions,
    "gatewayPath" | "healthPath" | "maxPayloadBytes" | "resolveClientIp"
  >;
};

export type PlatformClawWebIngressRuntime = {
  auth: EmployeeBrowserAuthRuntime;
  gateway: PlatformClawGatewayRuntimeClient;
  server: PlatformClawWebIngressServer;
  credentialBroker?: SshCredentialBroker;
  executionHandoff?: PlatformClawExecutionHandoffServer;
  prepare(): Promise<RestartReconciliationSummary>;
  listen(options: PlatformClawWebIngressListenOptions): Promise<void>;
  close(): Promise<void>;
};

/** Composes one BFF, one policy proxy, and one private Gateway client. */
export function createPlatformClawWebIngressRuntime(
  options: PlatformClawWebIngressRuntimeOptions,
): PlatformClawWebIngressRuntime {
  const auth = createEmployeeBrowserAuthRuntime({
    databasePath: options.databasePath,
    buildAgentMainSessionKey: options.buildAgentMainSessionKey,
    provisioner: options.provisioner,
    initialAdminAccountIds: options.initialAdminAccountIds,
    onLogoutAgent: async (agentId) => {
      await options.adminRpc.call("platformclaw-user-mcp.invalidateAgent", { agentId });
    },
    onAgentCredentialsRevoked: async (agentId) => {
      await options.adminRpc.call("platformclaw-user-mcp.invalidateAgent", { agentId });
    },
    ...options.employeeAuth,
  });
  if (options.credentialBrokerAddress && !auth.credentialVault) {
    throw new Error("credential broker requires an SSH credential vault");
  }
  const credentialBroker =
    options.credentialBrokerAddress && auth.credentialVault
      ? new SshCredentialBroker(options.credentialBrokerAddress, auth.credentialVault)
      : undefined;
  const mcpService = auth.mcpCredentialVault
    ? new EmployeeMcpService({
        authService: auth.service,
        store: auth.store,
        vault: auth.mcpCredentialVault,
        adminRpc: options.adminRpc,
        publicOrigin: options.publicOrigin,
        ...(options.employeeAuth?.fetchImpl ? { fetchImpl: options.employeeAuth.fetchImpl } : {}),
        ...(options.employeeAuth?.now ? { now: options.employeeAuth.now } : {}),
      })
    : undefined;
  if (options.executionServiceToken && !credentialBroker) {
    throw new Error("execution handoff requires a credential broker");
  }
  const executionService =
    credentialBroker && new ExecutionHandoffService(auth.store, credentialBroker);
  const executionHandoff =
    options.executionServiceToken && executionService && options.credentialBrokerAddress
      ? new PlatformClawExecutionHandoffServer(
          options.executionServiceToken,
          {
            resolveTarget: (agentId) => executionService.resolveTarget(agentId),
            resolveConnectionTarget: (agentId) => executionService.resolveConnectionTarget(agentId),
            changeTarget: (params) => executionService.changeTarget(params),
            issueCredentialGrant: (params) => executionService.issueCredentialGrant(params),
            ...(mcpService
              ? {
                  resolveMcpConnection: (agentId: string, serverName: string, serverUrl: string) =>
                    mcpService.resolveForAgent(agentId, serverName, serverUrl),
                }
              : {}),
          },
          deriveExecutionHandoffAddress(options.credentialBrokerAddress),
        )
      : undefined;
  const gateway = new PlatformClawGatewayRuntimeClient(options.gatewayClient);
  const knoxRouting = options.knoxRouting
    ? {
        service: new KnoxRoutingService({
          store: auth.store,
          roomProvisioner: options.knoxRouting.roomProvisioner,
          buildAgentMainSessionKey: options.buildAgentMainSessionKey,
          ...(options.employeeAuth?.now ? { now: options.employeeAuth.now } : {}),
        }),
        serviceToken: options.knoxRouting.serviceToken,
      }
    : undefined;
  const employeeExecution = new EmployeeExecutionService({
    authService: auth.service,
    store: auth.store,
    adminRpc: options.adminRpc,
    ...(auth.credentialVault ? { credentialVault: auth.credentialVault } : {}),
    ...(credentialBroker ? { credentialBroker } : {}),
    ...(options.employeeAuth?.now ? { now: options.employeeAuth.now } : {}),
  });
  const vmAdministration = new VmAdministrationService({
    authService: auth.service,
    store: auth.store,
    adminRpc: options.adminRpc,
    ...(options.employeeAuth?.now ? { now: options.employeeAuth.now } : {}),
  });
  const mcpAdministration = new McpAdministrationService({
    authService: auth.service,
    adminRpc: options.adminRpc,
    ...(mcpService ? { onCatalogChanged: () => mcpService.invalidateCatalog() } : {}),
  });
  const vocService = options.jiraVoc
    ? new JiraVocService({
        authService: auth.service,
        config: options.jiraVoc,
        ...(options.employeeAuth?.fetchImpl ? { fetchImpl: options.employeeAuth.fetchImpl } : {}),
      })
    : undefined;
  const skillHub = options.skillHub
    ? new SkillHubService({
        authService: auth.service,
        store: auth.store,
        adapter: options.skillHub.adapter,
        adminRpc: options.adminRpc,
        workspaceRoot: options.skillHub.workspaceRoot,
        allowedNamespaces: options.skillHub.allowedNamespaces,
        namespaceAccessGroups: options.skillHub.namespaceAccessGroups,
        maxPackageBytes: options.skillHub.maxPackageBytes,
        governance: options.skillHub.governance,
        primaryAdminUserId: options.skillHub.primaryAdminUserId,
        ...(options.employeeAuth?.now ? { now: options.employeeAuth.now } : {}),
      })
    : undefined;
  const restartReconciler = new AgentRestartReconciler({
    store: auth.store,
    personalAgentProbe: options.restartRecoveryProbe,
    ...(options.employeeAuth?.now ? { now: options.employeeAuth.now } : {}),
  });
  // Browser connections share this proxy; the session token resolves agent-scoped access per call.
  const gatewayProxy = new BrowserGatewayProxy({
    authService: auth.service,
    store: auth.store,
    auditWriter: auth.store,
    gateway,
    buildAgentMainSessionKey: options.buildAgentMainSessionKey,
    resolveAgentIdFromSessionKey: (sessionKey) => options.resolveAgentIdFromSessionKey(sessionKey),
    ...(options.employeeAuth?.now ? { now: options.employeeAuth.now } : {}),
  });
  const mediaRelay = options.mediaGateway
    ? new PlatformClawBrowserMediaRelay({
        gatewayOrigin: options.mediaGateway.origin,
        gatewayAuth: options.mediaGateway.auth,
        gatewayProxy,
        resolveAgentIdFromSessionKey: options.resolveAgentIdFromSessionKey,
        ...(options.mediaGateway.fetchImpl ? { fetchImpl: options.mediaGateway.fetchImpl } : {}),
        ...(options.employeeAuth?.now ? { now: options.employeeAuth.now } : {}),
      })
    : undefined;
  const canvasRelay = options.mediaGateway
    ? new PlatformClawBrowserCanvasRelay({
        publicOrigin: options.publicOrigin,
        gatewayOrigin: options.mediaGateway.origin,
        gatewayAuth: options.mediaGateway.auth,
        gatewayProxy,
        ...(options.mediaGateway.fetchImpl ? { fetchImpl: options.mediaGateway.fetchImpl } : {}),
        ...(options.employeeAuth?.now ? { now: options.employeeAuth.now } : {}),
      })
    : undefined;
  const server = new PlatformClawWebIngressServer({
    publicOrigin: options.publicOrigin,
    authService: auth.service,
    loginRateLimiter: new MemoryBrowserLoginRateLimiter(options.loginRateLimiter),
    gatewayProxy,
    gateway,
    ...(mediaRelay ? { mediaRelay } : {}),
    ...(canvasRelay ? { canvasRelay } : {}),
    executionService: employeeExecution,
    vmAdministrationService: vmAdministration,
    mcpAdministrationService: mcpAdministration,
    ...(vocService ? { vocService } : {}),
    ...(skillHub ? { skillHubService: skillHub } : {}),
    ...(knoxRouting ? { knoxRouting } : {}),
    ...(options.knoxIngressProxyUrl
      ? { knoxIngressProxy: { targetUrl: options.knoxIngressProxyUrl } }
      : {}),
    ...(mcpService ? { mcpService } : {}),
    webAssets: createPlatformClawWebAssetHandler(options.controlUiRoot, {
      publicOrigin: options.publicOrigin,
      vocEnabled: Boolean(vocService),
    }),
    ...options.ingress,
  });
  let closed = false;
  let preparing: Promise<RestartReconciliationSummary> | undefined;
  const prepare = (): Promise<RestartReconciliationSummary> => {
    preparing ??= restartReconciler.reconcile().then(async (summary) => {
      await skillHub?.processGovernanceQueue();
      return summary;
    });
    return preparing;
  };
  return {
    auth,
    gateway,
    server,
    ...(credentialBroker ? { credentialBroker } : {}),
    ...(executionHandoff ? { executionHandoff } : {}),
    prepare,
    async listen(listenOptions) {
      // No ingress may race a crash-left provisioning row during startup.
      await prepare();
      await credentialBroker?.listen();
      try {
        await executionHandoff?.listen();
        await server.listen(listenOptions);
      } catch (error) {
        await executionHandoff?.close();
        await credentialBroker?.close();
        throw error;
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await server.close();
      } finally {
        try {
          await executionHandoff?.close();
        } finally {
          try {
            await credentialBroker?.close();
          } finally {
            skillHub?.close();
            auth.close();
          }
        }
      }
    },
  };
}
