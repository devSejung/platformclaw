import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrowserLoginRateLimiter } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { EmployeeExecutionService } from "./browser-execution-http.js";
import type { BrowserGatewayAccess, BrowserGatewayEvent } from "./browser-gateway-proxy.js";
import type { McpAdministrationService } from "./browser-mcp-admin-http.js";
import type { EmployeeMcpService } from "./browser-mcp-http.js";
import type { BrowserOrganizationService } from "./browser-organization-http.js";
import type { VmAdministrationService } from "./browser-vm-admin-http.js";
import type { JiraVocService } from "./browser-voc-http.js";
import type { EmployeeSsoService } from "./employee-sso.js";
import type { ExecCredentialService } from "./exec-credential-service.js";
import type { PlatformClawGatewayBackend } from "./gateway-runtime-client.js";
import type { KnoxRoutingService } from "./knox-routing-service.js";
import type { SkillHubService } from "./skill-hub-service.js";
import type { PlatformClawWebAssetHandler } from "./web-assets.js";

export type PlatformClawBrowserGatewayPolicy = {
  resolveAccess(token: string, touch?: boolean): Promise<BrowserGatewayAccess>;
  registerBrowserConnection?(connectionId: string, access?: BrowserGatewayAccess): void;
  request(
    token: string,
    method: string,
    params?: unknown,
    context?: { connectionId: string },
  ): Promise<unknown>;
  filterEvent(
    token: string,
    event: BrowserGatewayEvent,
    context?: { connectionId: string },
    access?: BrowserGatewayAccess,
  ): Promise<BrowserGatewayEvent | null>;
  filterConnectionEvent?(
    event: BrowserGatewayEvent,
    context?: { connectionId: string },
  ): BrowserGatewayEvent | null | undefined;
  handleGatewayDisconnect?(): void;
  releaseBrowserConnection?(connectionId: string): Promise<void>;
};

export type PlatformClawBrowserMediaRelay = {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
};

export type PlatformClawBrowserCanvasRelay = {
  issueSurface(access: BrowserGatewayAccess): {
    pluginSurfaceUrls: { canvas: string };
    expiresAtMs: number;
  };
  refresh(token: string, params: unknown): Promise<unknown>;
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
};

export type PlatformClawWebIngressOptions = {
  publicOrigin: string;
  authService: BrowserAuthService;
  employeeSsoService?: EmployeeSsoService;
  loginRateLimiter: BrowserLoginRateLimiter;
  gatewayProxy: PlatformClawBrowserGatewayPolicy;
  gateway: PlatformClawGatewayBackend;
  executionService?: EmployeeExecutionService;
  vmAdministrationService?: VmAdministrationService;
  mcpAdministrationService?: McpAdministrationService;
  mcpService?: EmployeeMcpService;
  organizationService?: BrowserOrganizationService;
  execCredentialService?: ExecCredentialService;
  vocService?: JiraVocService;
  skillHubService?: SkillHubService;
  knoxRouting?: { service: KnoxRoutingService; serviceToken: string };
  knoxIngressProxy?: { targetUrl: string };
  mediaRelay?: PlatformClawBrowserMediaRelay;
  canvasRelay?: PlatformClawBrowserCanvasRelay;
  webAssets?: PlatformClawWebAssetHandler;
  gatewayPath?: string;
  healthPath?: string;
  maxPayloadBytes?: number;
  resolveClientIp?: (req: IncomingMessage) => string | undefined;
};

export type PlatformClawWebIngressListenOptions = {
  host: string;
  port: number;
};
