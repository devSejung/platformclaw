import { ControlPlaneStateError } from "./contracts.js";
import type {
  ControlPlaneMcpCredentialStore,
  ControlPlaneMcpSettingsStore,
  McpCredentialKind,
  McpCredentialPayload,
  StoredUserMcpCredential,
  UserMcpCredentialMetadata,
  McpUserSettingsPayload,
  StoredUserMcpSettings,
} from "./mcp-credential-contracts.js";
import { McpCredentialCipher } from "./mcp-credential-crypto.js";
import { mcpCredentialFingerprint } from "./mcp-credential-fingerprint.js";
import { assertAdditionalMcpHeader } from "./mcp-header-policy.js";

function hasInvalidHttpHeaderValue(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9) || code === 127 || code > 255) {
      return true;
    }
  }
  return false;
}

function requireSecret(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    hasInvalidHttpHeaderValue(value) ||
    Buffer.byteLength(normalized, "utf8") > 32 * 1024
  ) {
    throw new ControlPlaneStateError("MCP credential secret is invalid");
  }
  return normalized;
}

function requireHeaderName(value: string): string {
  const normalized = value.trim();
  assertAdditionalMcpHeader(normalized, []);
  return normalized;
}

export function normalizeMcpAdditionalHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(headers);
  if (entries.length > 32) {
    throw new ControlPlaneStateError("MCP additional headers exceed 32 entries");
  }
  const result: Array<[string, string]> = [];
  const names = new Set<string>();
  let bytes = 0;
  for (const [rawName, rawValue] of entries) {
    const name = requireHeaderName(rawName);
    if (name.length > 128 || typeof rawValue !== "string" || hasInvalidHttpHeaderValue(rawValue)) {
      throw new ControlPlaneStateError("MCP additional header is invalid");
    }
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new ControlPlaneStateError("MCP additional header names must be unique");
    }
    names.add(normalizedName);
    const value = rawValue.trim();
    const valueBytes = Buffer.byteLength(value, "utf8");
    bytes += Buffer.byteLength(name, "utf8") + valueBytes;
    if (valueBytes > 8 * 1024 || bytes > 32 * 1024) {
      throw new ControlPlaneStateError("MCP additional headers are too large");
    }
    if (value) {
      result.push([name, value]);
    }
  }
  return Object.fromEntries(result.toSorted(([left], [right]) => left.localeCompare(right)));
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

export type UserMcpSettings = Omit<
  StoredUserMcpSettings,
  "ciphertext" | "nonce" | "authTag" | "keyId" | "formatVersion"
> & {
  payload: McpUserSettingsPayload;
};

export class McpCredentialVault {
  constructor(
    private readonly store: ControlPlaneMcpCredentialStore & ControlPlaneMcpSettingsStore,
    private readonly cipher: McpCredentialCipher,
  ) {}

  async replaceSettings(params: {
    actorUserId: string;
    userId: string;
    serverName: string;
    enabled: boolean;
    payload: McpUserSettingsPayload;
    updatedAt: number;
    expectedRevision: number;
    credential?: { payload: McpCredentialPayload; expectedFingerprint: string | null };
  }) {
    const serverName = params.serverName.trim();
    const payload = {
      serverUrl: requireServerUrl(params.payload.serverUrl, "api_key"),
      headers: normalizeMcpAdditionalHeaders(params.payload.headers),
    };
    const credential = params.credential
      ? this.normalizePayload(params.credential.payload)
      : undefined;
    if (credential && credential.serverUrl !== payload.serverUrl) {
      throw new ControlPlaneStateError("MCP credential and settings destinations must match");
    }
    return await this.store.replaceEncryptedUserMcpSettings({
      actorUserId: params.actorUserId,
      userId: params.userId,
      serverName,
      enabled: params.enabled,
      envelope: this.cipher.encryptSettings(params.userId, serverName, payload),
      updatedAt: params.updatedAt,
      expectedRevision: params.expectedRevision,
      ...(credential && params.credential
        ? {
            credential: {
              kind: credential.kind,
              envelope: this.cipher.encrypt(params.userId, serverName, credential),
              expectedFingerprint: params.credential.expectedFingerprint,
            },
          }
        : {}),
    });
  }

  async readSettingsForUser(userId: string, serverName: string): Promise<UserMcpSettings | null> {
    const stored = await this.store.readEncryptedUserMcpSettings(userId, serverName);
    return stored ? this.decryptSettings(stored) : null;
  }

  async readStatusForUser(
    userId: string,
    serverName: string,
  ): Promise<{
    metadata: UserMcpCredentialMetadata;
    fingerprint: string;
    payload: McpCredentialPayload | null;
  } | null> {
    const stored = await this.store.readEncryptedUserMcpCredential(userId, serverName);
    if (!stored) {
      return null;
    }
    let payload: McpCredentialPayload | null = null;
    // Retained undecryptable secrets still need an accurate editor snapshot
    // and a visible deletion action; metadata must come from this same row.
    try {
      payload = this.decrypt(stored);
    } catch {
      /* Mark only this credential unconfigured. */
    }
    return {
      metadata: {
        userId: stored.userId,
        serverName: stored.serverName,
        kind: stored.kind,
        revision: stored.revision,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      },
      fingerprint: mcpCredentialFingerprint(stored),
      payload,
    };
  }

  async readSettingsForAgent(agentId: string, serverName: string): Promise<UserMcpSettings | null> {
    const stored = await this.store.readEncryptedMcpSettingsForAgent(agentId, serverName);
    return stored ? this.decryptSettings(stored) : null;
  }

  private decryptSettings(stored: StoredUserMcpSettings): UserMcpSettings {
    const payload = this.cipher.decryptSettings(stored.userId, stored.serverName, stored);
    return {
      userId: stored.userId,
      serverName: stored.serverName,
      enabled: stored.enabled,
      revision: stored.revision,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      payload: {
        serverUrl: requireServerUrl(payload.serverUrl, "api_key"),
        headers: normalizeMcpAdditionalHeaders(payload.headers),
      },
    };
  }

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
