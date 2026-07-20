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
import {
  PlatformClawGatewayRuntimeClient,
  type PlatformClawGatewayRuntimeClientOptions,
} from "./gateway-runtime-client.js";
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
  employeeAuth?: Pick<
    EmployeeBrowserAuthRuntimeOptions,
    "employeeAuthConfig" | "env" | "fetchImpl" | "now" | "tokenFactory"
  >;
  gatewayClient: PlatformClawGatewayRuntimeClientOptions;
  publicOrigin: string;
  loginRateLimiter?: MemoryBrowserLoginRateLimiterOptions;
  ingress?: Pick<
    PlatformClawWebIngressOptions,
    "gatewayPath" | "healthPath" | "maxPayloadBytes" | "resolveClientIp"
  >;
};

export type PlatformClawWebIngressRuntime = {
  auth: EmployeeBrowserAuthRuntime;
  gateway: PlatformClawGatewayRuntimeClient;
  server: PlatformClawWebIngressServer;
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
    ...options.employeeAuth,
  });
  const gateway = new PlatformClawGatewayRuntimeClient(options.gatewayClient);
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
    ...options.ingress,
  });
  let closed = false;
  return {
    auth,
    gateway,
    server,
    listen: (listenOptions) => server.listen(listenOptions),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await server.close();
      } finally {
        auth.close();
      }
    },
  };
}
