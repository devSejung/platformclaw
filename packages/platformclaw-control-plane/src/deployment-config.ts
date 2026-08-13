import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JiraVocConfig } from "./browser-voc-http.js";
import { parseJiraVocConfig } from "./jira-voc-config.js";
import { McpCredentialCipher } from "./mcp-credential-crypto.js";
import { SshCredentialCipher } from "./ssh-credential-crypto.js";

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 19_001;
const MAX_SECRET_FILE_BYTES = 16 * 1024;
const DEFAULT_SKILL_HUB_MAX_PACKAGE_BYTES = 10 * 1024 * 1024;

export const PLATFORMCLAW_DEPLOYMENT_ENV = {
  publicOrigin: "PLATFORMCLAW_PUBLIC_ORIGIN",
  listenHost: "PLATFORMCLAW_LISTEN_HOST",
  listenPort: "PLATFORMCLAW_LISTEN_PORT",
  databasePath: "PLATFORMCLAW_DATABASE_PATH",
  controlUiRoot: "PLATFORMCLAW_CONTROL_UI_ROOT",
  jiraVocConfigFile: "PLATFORMCLAW_JIRA_VOC_CONFIG_FILE",
  workspaceRoot: "PLATFORMCLAW_PERSONAL_WORKSPACE_ROOT",
  initialAdminAccountIdsFile: "PLATFORMCLAW_INITIAL_ADMIN_ACCOUNT_IDS_FILE",
  gatewayUrl: "PLATFORMCLAW_GATEWAY_URL",
  gatewayAuthFile: "PLATFORMCLAW_GATEWAY_TOKEN_FILE",
  gatewayServiceIdentityFile: "PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_FILE",
  sshCredentialMasterKeyFile: "PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_FILE",
  credentialBrokerAddress: "PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS",
  executionServiceTokenFile: "PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE",
  knoxServiceTokenFile: "PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE",
  skillHubUrl: "PLATFORMCLAW_SKILL_HUB_URL",
  skillHubTokenFile: "PLATFORMCLAW_SKILL_HUB_TOKEN_FILE",
  skillHubNamespaces: "PLATFORMCLAW_SKILL_HUB_NAMESPACES",
  skillHubMaxPackageBytes: "PLATFORMCLAW_SKILL_HUB_MAX_PACKAGE_BYTES",
} as const;

export type PlatformClawDeploymentConfig = {
  publicOrigin: string;
  listenHost: string;
  listenPort: number;
  databasePath: string;
  controlUiRoot: string;
  jiraVoc?: JiraVocConfig;
  workspaceRoot: string;
  initialAdminAccountIds: readonly string[];
  gatewayUrl: string;
  gatewayAdminRpcUrl: string;
  gatewayAuth: string;
  gatewayServiceIdentityFile: string;
  sshCredentialCipher: SshCredentialCipher;
  mcpCredentialCipher: McpCredentialCipher;
  credentialBrokerAddress: string;
  executionServiceToken: string;
  knoxServiceToken: string;
  skillHub?: {
    url: string;
    token: string;
    namespacePolicies: readonly { namespace: string; publishGroup: string }[];
    maxPackageBytes: number;
  };
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

function parsePositiveInteger(raw: string | undefined, name: string, fallback: number): number {
  if (!raw?.trim()) {
    return fallback;
  }
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function loadSkillHubConfig(env: NodeJS.ProcessEnv): PlatformClawDeploymentConfig["skillHub"] {
  const url = env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubUrl]?.trim();
  const tokenFile = env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubTokenFile]?.trim();
  const namespaceList = env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubNamespaces]?.trim();
  if (!url && !tokenFile && !namespaceList) {
    return undefined;
  }
  if (!url || !tokenFile || !namespaceList) {
    throw new Error(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubUrl}, ${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubTokenFile}, and ${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubNamespaces} must be set together`,
    );
  }
  const parsed = new URL(url);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubUrl} must be an HTTP(S) URL`);
  }
  const namespacePolicies = [
    ...new Map(
      namespaceList
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
          const separator = value.indexOf("=");
          const namespace = (separator === -1 ? value : value.slice(0, separator))
            .trim()
            .toLowerCase();
          const publishGroup = (separator === -1 ? value : value.slice(separator + 1))
            .trim()
            .toLowerCase();
          if (!namespace || !publishGroup) {
            throw new Error(`${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubNamespaces} is invalid`);
          }
          return [namespace, publishGroup] as const;
        }),
    ),
  ].map(([namespace, publishGroup]) => ({ namespace, publishGroup }));
  if (namespacePolicies.length === 0) {
    throw new Error(`${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubNamespaces} is empty`);
  }
  return {
    url: parsed.toString(),
    token: readDeploymentSecret(tokenFile, PLATFORMCLAW_DEPLOYMENT_ENV.skillHubTokenFile),
    namespacePolicies,
    maxPackageBytes: parsePositiveInteger(
      env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubMaxPackageBytes],
      PLATFORMCLAW_DEPLOYMENT_ENV.skillHubMaxPackageBytes,
      DEFAULT_SKILL_HUB_MAX_PACKAGE_BYTES,
    ),
  };
}

function readServiceToken(filePath: string, envName: string): string {
  const token = readDeploymentSecret(filePath, envName);
  if (Buffer.byteLength(token, "utf8") < 32 || Buffer.byteLength(token, "utf8") > 512) {
    throw new Error(`${envName} must contain 32 to 512 bytes`);
  }
  return token;
}

export function readDeploymentSecret(filePath: string, label: string): string {
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
  const credentialMasterKey = readDeploymentSecret(
    requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.sshCredentialMasterKeyFile),
    PLATFORMCLAW_DEPLOYMENT_ENV.sshCredentialMasterKeyFile,
  );
  const jiraVocConfigFile = env[PLATFORMCLAW_DEPLOYMENT_ENV.jiraVocConfigFile]?.trim();
  const skillHub = loadSkillHubConfig(env);
  return {
    publicOrigin: parsePublicOrigin(requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.publicOrigin)),
    listenHost: env[PLATFORMCLAW_DEPLOYMENT_ENV.listenHost]?.trim() || DEFAULT_LISTEN_HOST,
    listenPort,
    databasePath: resolve(requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.databasePath)),
    controlUiRoot: resolve(requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.controlUiRoot)),
    ...(jiraVocConfigFile
      ? {
          jiraVoc: parseJiraVocConfig(
            readDeploymentSecret(jiraVocConfigFile, PLATFORMCLAW_DEPLOYMENT_ENV.jiraVocConfigFile),
          ),
        }
      : {}),
    workspaceRoot: resolve(requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.workspaceRoot)),
    initialAdminAccountIds,
    gatewayUrl: gateway.websocketUrl,
    gatewayAdminRpcUrl: gateway.adminRpcUrl,
    gatewayAuth: readDeploymentSecret(
      requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile),
      PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile,
    ),
    gatewayServiceIdentityFile: resolve(
      requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.gatewayServiceIdentityFile),
    ),
    sshCredentialCipher: SshCredentialCipher.fromBase64(credentialMasterKey),
    mcpCredentialCipher: McpCredentialCipher.fromBase64(credentialMasterKey),
    credentialBrokerAddress: requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.credentialBrokerAddress),
    executionServiceToken: readServiceToken(
      requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.executionServiceTokenFile),
      PLATFORMCLAW_DEPLOYMENT_ENV.executionServiceTokenFile,
    ),
    knoxServiceToken: readServiceToken(
      requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.knoxServiceTokenFile),
      PLATFORMCLAW_DEPLOYMENT_ENV.knoxServiceTokenFile,
    ),
    ...(skillHub ? { skillHub } : {}),
  };
}
