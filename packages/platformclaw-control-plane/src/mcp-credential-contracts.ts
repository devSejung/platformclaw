export type McpCredentialKind = "bearer" | "api_key" | "oauth";

export type McpCredentialEnvelope = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  keyId: string;
  formatVersion: 1;
};

export type StoredUserMcpCredential = McpCredentialEnvelope & {
  userId: string;
  serverName: string;
  kind: McpCredentialKind;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type UserMcpCredentialMetadata = Omit<
  StoredUserMcpCredential,
  "ciphertext" | "nonce" | "authTag" | "keyId" | "formatVersion"
>;

export type McpBearerCredentialPayload = {
  kind: "bearer";
  serverUrl: string;
  token: string;
};

export type McpApiKeyCredentialPayload = {
  kind: "api_key";
  serverUrl: string;
  headerName: string;
  value: string;
};

export type McpOAuthCredentialPayload = {
  kind: "oauth";
  serverUrl: string;
  scope?: string;
  tokens?: import("@modelcontextprotocol/sdk/shared/auth.js").OAuthTokens;
  clientInformation?: import("@modelcontextprotocol/sdk/shared/auth.js").OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: import("@modelcontextprotocol/sdk/client/auth.js").OAuthDiscoveryState;
  expiresAt?: number;
};

export type McpCredentialPayload =
  | McpBearerCredentialPayload
  | McpApiKeyCredentialPayload
  | McpOAuthCredentialPayload;

export interface ControlPlaneMcpCredentialStore {
  replaceEncryptedUserMcpCredential(params: {
    actorUserId: string;
    userId: string;
    serverName: string;
    kind: McpCredentialKind;
    envelope: McpCredentialEnvelope;
    updatedAt: number;
    expectedRevision?: number;
  }): Promise<UserMcpCredentialMetadata>;
  readEncryptedUserMcpCredential(
    userId: string,
    serverName: string,
  ): Promise<StoredUserMcpCredential | null>;
  readEncryptedMcpCredentialForAgent(
    agentId: string,
    serverName: string,
  ): Promise<StoredUserMcpCredential | null>;
  listUserMcpCredentials(userId: string): Promise<UserMcpCredentialMetadata[]>;
  deleteUserMcpCredential(params: {
    actorUserId: string;
    userId: string;
    serverName: string;
    deletedAt: number;
  }): Promise<boolean>;
  deleteAllUserMcpCredentials(params: {
    actorUserId: string;
    userId: string;
    deletedAt: number;
  }): Promise<number>;
  createMcpOAuthState(params: {
    stateHash: string;
    userId: string;
    serverName: string;
    expiresAt: number;
    createdAt: number;
  }): Promise<void>;
  deleteMcpOAuthStates(userId: string, serverName: string): Promise<number>;
  consumeMcpOAuthState(
    stateHash: string,
    consumedAt: number,
  ): Promise<{
    userId: string;
    serverName: string;
  } | null>;
}
