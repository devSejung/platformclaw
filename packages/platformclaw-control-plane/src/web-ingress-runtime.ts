import {
  createEmployeeBrowserAuthRuntime,
  type EmployeeBrowserAuthRuntime,
  type EmployeeBrowserAuthRuntimeOptions,
} from "./browser-auth-runtime.js";
import type { PersonalAgentProvisioner } from "./browser-auth-service.js";
import { BrowserGatewayProxy } from "./browser-gateway-proxy.js";
import {
  MemoryBrowserLoginRateLimiter,
  type MemoryBrowserLoginRateLimiterOptions,
} from "./browser-login-rate-limiter.js";
import type { MainSessionKeyBuilder } from "./contracts.js";
import { PlatformClawExecutionHandoffServer } from "./execution-handoff-http.js";
import { ExecutionHandoffService } from "./execution-handoff-service.js";
import {
  PlatformClawGatewayRuntimeClient,
  type PlatformClawGatewayRuntimeClientOptions,
} from "./gateway-runtime-client.js";
import {
  AgentRestartReconciler,
  type PersonalAgentRestartRecoveryProbe,
  type RestartReconciliationSummary,
} from "./restart-reconciler.js";
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
    "employeeAuthConfig" | "env" | "fetchImpl" | "now" | "tokenFactory" | "sshCredentialCipher"
  >;
  gatewayClient: PlatformClawGatewayRuntimeClientOptions;
  publicOrigin: string;
  controlUiRoot: string;
  loginRateLimiter?: MemoryBrowserLoginRateLimiterOptions;
  credentialBrokerAddress?: string;
  executionServiceToken?: string;
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
  listen(
    options: PlatformClawWebIngressListenOptions & {
      internalHost?: string;
      internalPort?: number;
    },
  ): Promise<void>;
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
    ...options.employeeAuth,
  });
  if (options.credentialBrokerAddress && !auth.credentialVault) {
    throw new Error("credential broker requires an SSH credential vault");
  }
  const credentialBroker =
    options.credentialBrokerAddress && auth.credentialVault
      ? new SshCredentialBroker(options.credentialBrokerAddress, auth.credentialVault)
      : undefined;
  if (options.executionServiceToken && !credentialBroker) {
    throw new Error("execution handoff requires a credential broker");
  }
  const executionHandoff =
    options.executionServiceToken && credentialBroker
      ? new PlatformClawExecutionHandoffServer(
          options.executionServiceToken,
          new ExecutionHandoffService(auth.store, credentialBroker),
        )
      : undefined;
  const gateway = new PlatformClawGatewayRuntimeClient(options.gatewayClient);
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
  const server = new PlatformClawWebIngressServer({
    publicOrigin: options.publicOrigin,
    authService: auth.service,
    loginRateLimiter: new MemoryBrowserLoginRateLimiter(options.loginRateLimiter),
    gatewayProxy,
    gateway,
    webAssets: createPlatformClawWebAssetHandler(options.controlUiRoot, {
      publicOrigin: options.publicOrigin,
    }),
    ...options.ingress,
  });
  let closed = false;
  let preparing: Promise<RestartReconciliationSummary> | undefined;
  const prepare = (): Promise<RestartReconciliationSummary> => {
    preparing ??= restartReconciler.reconcile();
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
        await executionHandoff?.listen({
          host: listenOptions.internalHost ?? "127.0.0.1",
          port: listenOptions.internalPort ?? 0,
        });
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
            auth.close();
          }
        }
      }
    },
  };
}
