import { createHash, randomBytes } from "node:crypto";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthError,
  TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  ControlPlaneMcpCredentialStore,
  McpOAuthCredentialPayload,
} from "./mcp-credential-contracts.js";
import type { McpCredentialVault, ResolvedAgentMcpCredential } from "./mcp-credential-vault.js";
import { createMcpOAuthFetch } from "./mcp-oauth-fetch.js";

const OAUTH_STATE_TTL_MS = 10 * 60_000;
// Requester-scoped Gateway runtimes sweep expiring connections every 60 seconds.
// Never return a token that the Gateway must reject before its next sweep.
const TOKEN_EXPIRY_SKEW_MS = 60_000;

function stateHash(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function safeAccessToken(value: string | undefined): string | null {
  const token = value?.trim();
  return token &&
    !token.includes("\0") &&
    !token.includes("\r") &&
    !token.includes("\n") &&
    Buffer.byteLength(token, "utf8") <= 32 * 1024
    ? token
    : null;
}

export function isMcpOAuthCredentialUsable(
  payload: McpOAuthCredentialPayload,
  now: number,
): boolean {
  const accessToken = safeAccessToken(payload.tokens?.access_token);
  const accessTokenIsUsable =
    accessToken !== null && (!payload.expiresAt || payload.expiresAt > now + TOKEN_EXPIRY_SKEW_MS);
  return accessTokenIsUsable || safeAccessToken(payload.tokens?.refresh_token) !== null;
}

function safeAuthorizationUrl(value: URL | undefined): string {
  if (value && value.protocol === "https:" && !value.username && !value.password && !value.hash) {
    return value.toString();
  }
  throw new Error("MCP OAuth authorization URL is invalid");
}

class PersistentOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  private revision: number;

  constructor(
    private payload: McpOAuthCredentialPayload,
    private readonly options: {
      userId: string;
      serverName: string;
      redirectUrl: string;
      scope?: string;
      state?: () => Promise<string>;
      now: () => number;
      vault: McpCredentialVault;
      revision: number;
    },
  ) {
    this.revision = options.revision;
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.options.redirectUrl],
      client_name: "PlatformClaw",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    };
  }

  state(): Promise<string> {
    if (!this.options.state) {
      throw new Error("interactive MCP OAuth authorization required");
    }
    return this.options.state();
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.payload.clientInformation;
  }

  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.payload = { ...this.payload, clientInformation: value };
    await this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.payload.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.payload = {
      ...this.payload,
      tokens,
      ...(tokens.expires_in === undefined
        ? { expiresAt: undefined }
        : { expiresAt: this.options.now() + tokens.expires_in * 1_000 }),
    };
    await this.persist();
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.payload = { ...this.payload, codeVerifier };
    await this.persist();
  }

  codeVerifier(): string {
    if (!this.payload.codeVerifier) {
      throw new Error("MCP OAuth code verifier is unavailable");
    }
    return this.payload.codeVerifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    this.payload = { ...this.payload, discoveryState };
    await this.persist();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.payload.discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const next = { ...this.payload };
    if (scope === "all" || scope === "client") {
      delete next.clientInformation;
    }
    if (scope === "all" || scope === "tokens") {
      delete next.tokens;
      delete next.expiresAt;
    }
    if (scope === "all" || scope === "verifier") {
      delete next.codeVerifier;
    }
    if (scope === "all" || scope === "discovery") {
      delete next.discoveryState;
    }
    this.payload = next;
    await this.persist();
  }

  currentPayload(): McpOAuthCredentialPayload {
    return this.payload;
  }

  currentRevision(): number {
    return this.revision;
  }

  private async persist(): Promise<void> {
    const metadata = await this.options.vault.replace({
      actorUserId: this.options.userId,
      userId: this.options.userId,
      serverName: this.options.serverName,
      payload: this.payload,
      updatedAt: this.options.now(),
      expectedRevision: this.revision,
    });
    this.revision = metadata.revision;
  }
}

export class McpOAuthService {
  private readonly now: () => number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly credentialLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      store: ControlPlaneMcpCredentialStore;
      vault: McpCredentialVault;
      redirectUrl: string;
      fetchImpl?: typeof globalThis.fetch;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.fetchImpl = createMcpOAuthFetch(options.fetchImpl);
  }

  async begin(params: { userId: string; serverName: string; serverUrl: string; scope?: string }) {
    const credential = await this.oauthCredential(
      params.userId,
      params.serverName,
      params.serverUrl,
      params.scope,
    );
    // The provider persists one verifier per user/server. Invalidate every
    // earlier callback before SDK discovery can overwrite that verifier.
    await this.options.store.deleteMcpOAuthStates(params.userId, params.serverName);
    const state = randomBytes(32).toString("base64url");
    const provider = new PersistentOAuthProvider(credential.payload, {
      ...params,
      redirectUrl: this.options.redirectUrl,
      now: this.now,
      vault: this.options.vault,
      revision: credential.revision,
      state: async () => {
        const createdAt = this.now();
        await this.options.store.createMcpOAuthState({
          stateHash: stateHash(state),
          userId: params.userId,
          serverName: params.serverName,
          createdAt,
          expiresAt: createdAt + OAUTH_STATE_TTL_MS,
        });
        return state;
      },
    });
    if (credential.payload.tokens) {
      // Reconnect is an explicit account/consent action. Runtime resolution
      // owns silent renewal; the browser action must always reach authorization.
      await provider.invalidateCredentials("tokens");
    }
    const result = await auth(provider, {
      serverUrl: params.serverUrl,
      ...(params.scope ? { scope: params.scope } : {}),
      fetchFn: this.fetchImpl,
    });
    return result === "AUTHORIZED"
      ? { status: "authorized" as const }
      : {
          status: "redirect" as const,
          authorizationUrl: safeAuthorizationUrl(provider.authorizationUrl),
        };
  }

  async consumeState(state: string): Promise<{ userId: string; serverName: string } | null> {
    return await this.options.store.consumeMcpOAuthState(stateHash(state), this.now());
  }

  async complete(params: {
    userId: string;
    serverName: string;
    serverUrl: string;
    code: string;
    scope?: string;
  }): Promise<void> {
    const credential = await this.oauthCredential(
      params.userId,
      params.serverName,
      params.serverUrl,
      params.scope,
    );
    const provider = new PersistentOAuthProvider(credential.payload, {
      ...params,
      redirectUrl: this.options.redirectUrl,
      now: this.now,
      vault: this.options.vault,
      revision: credential.revision,
    });
    const result = await auth(provider, {
      serverUrl: params.serverUrl,
      authorizationCode: params.code,
      ...(params.scope ? { scope: params.scope } : {}),
      fetchFn: this.fetchImpl,
    });
    if (result !== "AUTHORIZED") {
      throw new Error("MCP OAuth authorization did not complete");
    }
  }

  async resolveForAgent(params: {
    userId: string;
    serverName: string;
    serverUrl: string;
    scope?: string;
    revision: number;
    payload: McpOAuthCredentialPayload;
  }): Promise<ResolvedAgentMcpCredential | null> {
    return await this.withCredentialLock(params.userId, params.serverName, async () => {
      const current = await this.oauthCredential(
        params.userId,
        params.serverName,
        params.serverUrl,
        params.scope,
      );
      return await this.resolveForAgentLocked({ ...params, ...current });
    });
  }

  private async resolveForAgentLocked(params: {
    userId: string;
    serverName: string;
    serverUrl: string;
    scope?: string;
    revision: number;
    payload: McpOAuthCredentialPayload;
  }): Promise<ResolvedAgentMcpCredential | null> {
    const token = safeAccessToken(params.payload.tokens?.access_token);
    if (
      token &&
      (!params.payload.expiresAt || params.payload.expiresAt > this.now() + TOKEN_EXPIRY_SKEW_MS)
    ) {
      return {
        headers: { Authorization: `Bearer ${token}` },
        revision: params.revision,
        ...(params.payload.expiresAt ? { expiresAt: params.payload.expiresAt } : {}),
      };
    }
    if (!safeAccessToken(params.payload.tokens?.refresh_token)) {
      return null;
    }
    const provider = new PersistentOAuthProvider(params.payload, {
      ...params,
      redirectUrl: this.options.redirectUrl,
      now: this.now,
      vault: this.options.vault,
      revision: params.revision,
    });
    try {
      const result = await auth(provider, {
        serverUrl: params.serverUrl,
        ...(params.scope ? { scope: params.scope } : {}),
        fetchFn: this.fetchImpl,
      });
      const refreshedPayload = provider.currentPayload();
      const refreshed = safeAccessToken(refreshedPayload.tokens?.access_token);
      const refreshedIsUsable =
        refreshed &&
        (!refreshedPayload.expiresAt ||
          refreshedPayload.expiresAt > this.now() + TOKEN_EXPIRY_SKEW_MS);
      return result === "AUTHORIZED" && refreshedIsUsable
        ? {
            headers: { Authorization: `Bearer ${refreshed}` },
            revision: provider.currentRevision(),
            ...(refreshedPayload.expiresAt ? { expiresAt: refreshedPayload.expiresAt } : {}),
          }
        : null;
    } catch (error) {
      if (error instanceof OAuthError && !(error instanceof TemporarilyUnavailableError)) {
        // A protocol-level rejection (for example, a revoked renewal grant) is
        // not recoverable by retry. Remove only tokens so the browser can show
        // reconnect-required while retaining discovery/client metadata.
        await provider.invalidateCredentials("tokens").catch(() => undefined);
      }
      return null;
    }
  }

  private async withCredentialLock<T>(
    userId: string,
    serverName: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${userId}\0${serverName}`;
    const previous = this.credentialLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.credentialLocks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.credentialLocks.get(key) === tail) {
        this.credentialLocks.delete(key);
      }
    }
  }

  private async oauthCredential(
    userId: string,
    serverName: string,
    serverUrl: string,
    scope?: string,
  ): Promise<{ payload: McpOAuthCredentialPayload; revision: number }> {
    const existing = await this.options.vault.readForUser(userId, serverName);
    return existing?.payload.kind === "oauth" &&
      existing.payload.serverUrl === serverUrl &&
      existing.payload.scope === scope
      ? { payload: existing.payload, revision: existing.revision }
      : {
          payload: { kind: "oauth", serverUrl, ...(scope ? { scope } : {}) },
          revision: existing?.revision ?? 0,
        };
  }
}
