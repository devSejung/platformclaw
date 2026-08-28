import type { BrowserAuthService } from "./browser-auth-service.js";
import type {
  ControlPlaneAuditWriter,
  ControlPlaneStore,
  OrganizationMemoryLifecycle,
  OrganizationMemoryDocument,
  OrganizationMemorySearchHit,
  PersonalAgentBinding,
  PlatformUser,
  BrowserSession,
} from "./contracts.js";

export type BrowserGatewayEvent = {
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: Record<string, number>;
};

export type BrowserGatewayRpc = {
  request(method: string, params?: unknown): Promise<unknown>;
};

export type BrowserGatewayRequestContext = {
  connectionId: string;
};

export type BrowserGatewayAccess = {
  user: PlatformUser;
  session?: BrowserSession;
  binding: PersonalAgentBinding;
  mainSessionKey: string;
};

export type BrowserGatewayProxyErrorCode =
  | "unauthenticated"
  | "agent-unavailable"
  | "method-not-allowed"
  | "invalid-params"
  | "cross-agent-denied"
  | "upstream-result-denied";

export class BrowserGatewayProxyError extends Error {
  constructor(
    readonly code: BrowserGatewayProxyErrorCode,
    message: string,
    readonly requestDisposition?: "rejected-before-dispatch",
  ) {
    super(message);
    this.name = "BrowserGatewayProxyError";
  }
}

export function asBrowserGatewayObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserGatewayProxyError("invalid-params", `${label} must be an object`);
  }
  return { ...(value as Record<string, unknown>) };
}

export type BrowserGatewayProxyOptions = {
  authService: BrowserAuthService;
  store: ControlPlaneStore;
  auditWriter: ControlPlaneAuditWriter;
  gateway: BrowserGatewayRpc;
  buildAgentMainSessionKey(params: { agentId: string }): string;
  resolveAgentIdFromSessionKey(sessionKey: string): string | null;
  searchOrganizationMemory?(params: {
    agentId: string;
    query: string;
    maxResults?: number;
  }): Promise<OrganizationMemorySearchHit[]>;
  getOrganizationMemory?(params: {
    agentId: string;
    path: string;
    fromLine?: number;
    lineCount?: number;
  }): Promise<OrganizationMemoryDocument | null>;
  organizationMemoryLifecycle?: OrganizationMemoryLifecycle;
  now?: () => number;
};
