import type { BaseballGameStore } from "./baseball-contracts.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type {
  ControlPlaneAuditWriter,
  ControlPlaneStore,
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
  isConnected?: () => boolean;
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
  baseballStore?: BaseballGameStore;
  spaceService?: import("./space-service.js").SpaceService;
  vaultService?: import("./knowledge-vault-service.js").KnowledgeVaultService;
  buildAgentMainSessionKey(params: { agentId: string }): string;
  resolveAgentIdFromSessionKey(sessionKey: string): string | null;
  now?: () => number;
};
