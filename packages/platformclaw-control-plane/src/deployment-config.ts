import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SshCredentialCipher } from "./ssh-credential-crypto.js";

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 19_001;
export const DEFAULT_INTERNAL_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_INTERNAL_LISTEN_PORT = 19_002;
const MAX_SECRET_FILE_BYTES = 16 * 1024;

export const PLATFORMCLAW_DEPLOYMENT_ENV = {
  publicOrigin: "PLATFORMCLAW_PUBLIC_ORIGIN",
  listenHost: "PLATFORMCLAW_LISTEN_HOST",
  listenPort: "PLATFORMCLAW_LISTEN_PORT",
  internalListenHost: "PLATFORMCLAW_INTERNAL_LISTEN_HOST",
  internalListenPort: "PLATFORMCLAW_INTERNAL_LISTEN_PORT",
  databasePath: "PLATFORMCLAW_DATABASE_PATH",
  controlUiRoot: "PLATFORMCLAW_CONTROL_UI_ROOT",
  workspaceRoot: "PLATFORMCLAW_PERSONAL_WORKSPACE_ROOT",
  initialAdminAccountIdsFile: "PLATFORMCLAW_INITIAL_ADMIN_ACCOUNT_IDS_FILE",
  gatewayUrl: "PLATFORMCLAW_GATEWAY_URL",
  gatewayAuthFile: "PLATFORMCLAW_GATEWAY_TOKEN_FILE",
  sshCredentialMasterKeyFile: "PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_FILE",
  credentialBrokerAddress: "PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS",
  executionServiceTokenFile: "PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE",
} as const;

export type PlatformClawDeploymentConfig = {
  publicOrigin: string;
  listenHost: string;
  listenPort: number;
  internalListenHost: string;
  internalListenPort: number;
  databasePath: string;
  controlUiRoot: string;
  workspaceRoot: string;
  initialAdminAccountIds: readonly string[];
  gatewayUrl: string;
  gatewayAdminRpcUrl: string;
  gatewayAuth: string;
  sshCredentialCipher: SshCredentialCipher;
  credentialBrokerAddress: string;
  executionServiceToken: string;
};

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePublicOrigin(raw: string): string {
  const url = new URL(raw);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${PLATFORMCLAW_DEPLOYMENT_ENV.publicOrigin} must be an HTTP(S) origin`);
  }
  return url.origin;
}

function parseGatewayUrl(raw: string): { websocketUrl: string; adminRpcUrl: string } {
  const url = new URL(raw);
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${PLATFORMCLAW_DEPLOYMENT_ENV.gatewayUrl} must be a WS(S) origin`);
  }
  const websocketUrl = url.origin;
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/v1/admin/rpc";
  return { websocketUrl, adminRpcUrl: url.toString() };
}

function parsePort(raw: string | undefined, name: string, defaultPort: number): number {
  if (!raw?.trim()) {
    return defaultPort;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be between 1 and 65535`);
  }
  return port;
}

function readExecutionServiceToken(filePath: string): string {
  const token = readDeploymentSecret(
    filePath,
    PLATFORMCLAW_DEPLOYMENT_ENV.executionServiceTokenFile,
  );
  if (Buffer.byteLength(token, "utf8") < 32 || Buffer.byteLength(token, "utf8") > 512) {
    throw new Error(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.executionServiceTokenFile} must contain 32 to 512 bytes`,
    );
  }
  return token;
}

function readDeploymentSecret(filePath: string, label: string): string {
  const resolvedPath = resolve(filePath);
  const stat = lstatSync(resolvedPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must reference a regular file`);
  }
  if (stat.size > MAX_SECRET_FILE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_SECRET_FILE_BYTES} bytes`);
  }
  const value = readFileSync(resolvedPath, "utf8").trim();
  if (!value) {
    throw new Error(`${label} is empty`);
  }
  return value;
}

function parseInitialAdminAccountIds(raw: string): string[] {
  const accountIds = [
    ...new Set(
      raw
        .split(/[\r\n,]+/u)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].toSorted();
  if (accountIds.length === 0) {
    throw new Error("initial administrator account ID file is empty");
  }
  return accountIds;
}

export function loadPlatformClawDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlatformClawDeploymentConfig {
  const gateway = parseGatewayUrl(requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.gatewayUrl));
  const initialAdminAccountIds = parseInitialAdminAccountIds(
    readDeploymentSecret(
      requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.initialAdminAccountIdsFile),
      PLATFORMCLAW_DEPLOYMENT_ENV.initialAdminAccountIdsFile,
    ),
  );
  const listenPort = parsePort(
    env[PLATFORMCLAW_DEPLOYMENT_ENV.listenPort],
    PLATFORMCLAW_DEPLOYMENT_ENV.listenPort,
    DEFAULT_LISTEN_PORT,
  );
  const internalListenPort = parsePort(
    env[PLATFORMCLAW_DEPLOYMENT_ENV.internalListenPort],
    PLATFORMCLAW_DEPLOYMENT_ENV.internalListenPort,
    DEFAULT_INTERNAL_LISTEN_PORT,
  );
  if (listenPort === internalListenPort) {
    throw new Error("PlatformClaw public and internal listen ports must differ");
  }
  return {
    publicOrigin: parsePublicOrigin(requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.publicOrigin)),
    listenHost: env[PLATFORMCLAW_DEPLOYMENT_ENV.listenHost]?.trim() || DEFAULT_LISTEN_HOST,
    listenPort,
    internalListenHost:
      env[PLATFORMCLAW_DEPLOYMENT_ENV.internalListenHost]?.trim() || DEFAULT_INTERNAL_LISTEN_HOST,
    internalListenPort,
    databasePath: resolve(requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.databasePath)),
    controlUiRoot: resolve(requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.controlUiRoot)),
    workspaceRoot: resolve(requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.workspaceRoot)),
    initialAdminAccountIds,
    gatewayUrl: gateway.websocketUrl,
    gatewayAdminRpcUrl: gateway.adminRpcUrl,
    gatewayAuth: readDeploymentSecret(
      requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile),
      PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile,
    ),
    sshCredentialCipher: SshCredentialCipher.fromBase64(
      readDeploymentSecret(
        requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.sshCredentialMasterKeyFile),
        PLATFORMCLAW_DEPLOYMENT_ENV.sshCredentialMasterKeyFile,
      ),
    ),
    credentialBrokerAddress: requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.credentialBrokerAddress),
    executionServiceToken: readExecutionServiceToken(
      requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.executionServiceTokenFile),
    ),
  };
}
