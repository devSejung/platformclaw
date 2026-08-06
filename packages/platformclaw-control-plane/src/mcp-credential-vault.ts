import { ControlPlaneStateError } from "./contracts.js";
import type {
  ControlPlaneMcpCredentialStore,
  McpCredentialKind,
  McpCredentialPayload,
  StoredUserMcpCredential,
  UserMcpCredentialMetadata,
} from "./mcp-credential-contracts.js";
import { McpCredentialCipher } from "./mcp-credential-crypto.js";

function requireSecret(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.includes("\r") ||
    normalized.includes("\n") ||
    Buffer.byteLength(normalized, "utf8") > 32 * 1024
  ) {
    throw new ControlPlaneStateError("MCP credential secret is invalid");
  }
  return normalized;
}

function requireHeaderName(value: string): string {
  const normalized = value.trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(normalized)) {
    throw new ControlPlaneStateError("MCP credential header name is invalid");
  }
  return normalized;
}

function requireServerUrl(value: string, kind: McpCredentialKind): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "https:" || (kind !== "oauth" && url.protocol === "http:")) &&
      !url.username &&
      !url.password &&
      !url.hash
    ) {
      return url.toString();
    }
  } catch {
    // Fall through to the stable state error below.
  }
  throw new ControlPlaneStateError(
    kind === "oauth"
      ? "MCP OAuth server URL must use HTTPS"
      : "MCP credential server URL must use HTTP or HTTPS",
  );
}

function normalizeOAuthScope(value: string | undefined): string | undefined {
  const scope = value?.trim();
  if (
    scope &&
    (scope.length > 2_048 || scope.includes("\0") || scope.includes("\r") || scope.includes("\n"))
  ) {
    throw new ControlPlaneStateError("MCP OAuth scope is invalid");
  }
  return scope || undefined;
}

export type ResolvedAgentMcpCredential = {
  headers: Record<string, string>;
  revision: number;
  expiresAt?: number;
};

export type AgentMcpCredentialPayload = {
  userId: string;
  serverName: string;
  revision: number;
  payload: McpCredentialPayload;
};

export class McpCredentialVault {
  constructor(
    private readonly store: ControlPlaneMcpCredentialStore,
    private readonly cipher: McpCredentialCipher,
  ) {}

  async replace(params: {
    actorUserId: string;
    userId: string;
    serverName: string;
    payload: McpCredentialPayload;
    updatedAt: number;
    expectedRevision?: number;
  }): Promise<UserMcpCredentialMetadata> {
    const payload = this.normalizePayload(params.payload);
    const envelope = this.cipher.encrypt(params.userId, params.serverName, payload);
    return await this.store.replaceEncryptedUserMcpCredential({
      actorUserId: params.actorUserId,
      userId: params.userId,
      serverName: params.serverName,
      kind: payload.kind,
      envelope,
      updatedAt: params.updatedAt,
      expectedRevision: params.expectedRevision,
    });
  }

  async readPayload(userId: string, serverName: string): Promise<McpCredentialPayload | null> {
    return (await this.readForUser(userId, serverName))?.payload ?? null;
  }

  async readForUser(userId: string, serverName: string): Promise<AgentMcpCredentialPayload | null> {
    const stored = await this.store.readEncryptedUserMcpCredential(userId, serverName);
    return stored
      ? {
          userId: stored.userId,
          serverName: stored.serverName,
          revision: stored.revision,
          payload: this.decrypt(stored),
        }
      : null;
  }

  async resolveForAgent(
    agentId: string,
    serverName: string,
  ): Promise<ResolvedAgentMcpCredential | null> {
    const stored = await this.store.readEncryptedMcpCredentialForAgent(agentId, serverName);
    if (!stored) {
      return null;
    }
    const payload = this.decrypt(stored);
    if (payload.kind === "bearer") {
      return { headers: { Authorization: `Bearer ${payload.token}` }, revision: stored.revision };
    }
    if (payload.kind === "api_key") {
      return {
        headers: { [payload.headerName]: payload.value },
        revision: stored.revision,
      };
    }
    // OAuth expiry and refresh are enforced by McpOAuthService. Never expose a
    // possibly stale access token through the static-secret path.
    return null;
  }

  async readForAgent(
    agentId: string,
    serverName: string,
  ): Promise<AgentMcpCredentialPayload | null> {
    const stored = await this.store.readEncryptedMcpCredentialForAgent(agentId, serverName);
    return stored
      ? {
          userId: stored.userId,
          serverName: stored.serverName,
          revision: stored.revision,
          payload: this.decrypt(stored),
        }
      : null;
  }

  private decrypt(stored: StoredUserMcpCredential): McpCredentialPayload {
    const payload = this.cipher.decrypt(stored.userId, stored.serverName, stored);
    if (payload.kind !== stored.kind) {
      throw new ControlPlaneStateError("MCP credential metadata does not match its payload");
    }
    return this.normalizePayload(payload);
  }

  private normalizePayload(payload: McpCredentialPayload): McpCredentialPayload {
    if (payload.kind === "bearer") {
      return {
        kind: payload.kind,
        serverUrl: requireServerUrl(payload.serverUrl, payload.kind),
        token: requireSecret(payload.token),
      };
    }
    if (payload.kind === "api_key") {
      return {
        kind: payload.kind,
        serverUrl: requireServerUrl(payload.serverUrl, payload.kind),
        headerName: requireHeaderName(payload.headerName),
        value: requireSecret(payload.value),
      };
    }
    if (payload.kind !== "oauth") {
      throw new ControlPlaneStateError("unsupported MCP credential kind");
    }
    const scope = normalizeOAuthScope(payload.scope);
    return {
      ...payload,
      kind: "oauth",
      serverUrl: requireServerUrl(payload.serverUrl, payload.kind),
      ...(scope ? { scope } : { scope: undefined }),
    };
  }
}

export function isMcpCredentialKind(value: unknown): value is McpCredentialKind {
  return value === "bearer" || value === "api_key" || value === "oauth";
}
