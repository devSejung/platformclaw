import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JiraVocConfig } from "./browser-voc-http.js";
import { normalizeEmployeeSsoLoginUrl, type EmployeeSsoConfig } from "./employee-sso.js";
import { ExecCredentialCipher } from "./exec-credential-crypto.js";
import type { PlatformClawGuideVideoS3Config } from "./guide-video-s3.js";
import { parseJiraVocConfig } from "./jira-voc-config.js";
import { McpCredentialCipher } from "./mcp-credential-crypto.js";
import { SshCredentialCipher } from "./ssh-credential-crypto.js";

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 19_001;
const MAX_SECRET_FILE_BYTES = 16 * 1024;
const DEFAULT_SKILL_HUB_MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_GUIDE_VIDEO_S3_REGION = "us-east-1";

export const PLATFORMCLAW_DEPLOYMENT_ENV = {
  publicOrigin: "PLATFORMCLAW_PUBLIC_ORIGIN",
  guideVideoUrl: "PLATFORMCLAW_GUIDE_VIDEO_URL",
  guideVideoS3Endpoint: "PLATFORMCLAW_GUIDE_VIDEO_S3_ENDPOINT",
  guideVideoS3Region: "PLATFORMCLAW_GUIDE_VIDEO_S3_REGION",
  guideVideoS3Bucket: "PLATFORMCLAW_GUIDE_VIDEO_S3_BUCKET",
  guideVideoS3Key: "PLATFORMCLAW_GUIDE_VIDEO_S3_KEY",
  guideVideoS3AccessKeyFile: "PLATFORMCLAW_GUIDE_VIDEO_S3_ACCESS_KEY_FILE",
  guideVideoS3SecretKeyFile: "PLATFORMCLAW_GUIDE_VIDEO_S3_SECRET_KEY_FILE",
  guideVideoS3ForcePathStyle: "PLATFORMCLAW_GUIDE_VIDEO_S3_FORCE_PATH_STYLE",
  listenHost: "PLATFORMCLAW_LISTEN_HOST",
  listenPort: "PLATFORMCLAW_LISTEN_PORT",
  databasePath: "PLATFORMCLAW_DATABASE_PATH",
  controlUiRoot: "PLATFORMCLAW_CONTROL_UI_ROOT",
  jiraVocConfigFile: "PLATFORMCLAW_JIRA_VOC_CONFIG_FILE",
  employeeAuthAdSsoUrl: "PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_URL",
  employeeAuthAdSsoSecretFile: "PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_SECRET_FILE",
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
  skillHubBootstrapPasswordFile: "PLATFORMCLAW_SKILL_HUB_BOOTSTRAP_PASSWORD_FILE",
  skillHubPrimaryAdminId: "PLATFORMCLAW_SKILL_HUB_PRIMARY_ADMIN_ID",
} as const;

export type PlatformClawDeploymentConfig = {
  publicOrigin: string;
  guideVideoUrl?: string;
  guideVideoS3?: PlatformClawGuideVideoS3Config;
  listenHost: string;
  listenPort: number;
  databasePath: string;
  controlUiRoot: string;
  jiraVoc?: JiraVocConfig;
  employeeSso?: EmployeeSsoConfig;
  workspaceRoot: string;
  initialAdminAccountIds: readonly string[];
  gatewayUrl: string;
  gatewayAdminRpcUrl: string;
  gatewayAuth: string;
  gatewayServiceIdentityFile: string;
  sshCredentialCipher: SshCredentialCipher;
  mcpCredentialCipher: McpCredentialCipher;
  execCredentialCipher: ExecCredentialCipher;
  credentialBrokerAddress: string;
  executionServiceToken: string;
  knoxServiceToken: string;
  skillHub?: {
    url: string;
    token: string;
    namespaces: readonly string[];
    maxPackageBytes: number;
    bootstrapPassword: string;
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

function parseGuideVideoUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoUrl} must be an HTTP(S) URL without embedded credentials`,
    );
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoUrl} must be an HTTP(S) URL without embedded credentials`,
    );
  }
  return url.toString();
}

function parseOptionalBoolean(raw: string | undefined, name: string, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parseGuideVideoS3Endpoint(raw: string, name: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  return endpoint.origin;
}

function loadGuideVideoS3Config(
  env: NodeJS.ProcessEnv,
): PlatformClawGuideVideoS3Config | undefined {
  const endpoint = env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Endpoint]?.trim();
  const region = env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Region]?.trim();
  const bucket = env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Bucket]?.trim();
  const key = env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Key]?.trim();
  const accessKeyFile = env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3AccessKeyFile]?.trim();
  const secretKeyFile = env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3SecretKeyFile]?.trim();
  const forcePathStyleRaw = env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3ForcePathStyle]?.trim();
  // Region, secret-file paths, and path-style have harmless deployment defaults;
  // only the endpoint/bucket/key triplet opts the deployment into private S3 mode.
  if (!endpoint && !bucket && !key) {
    return undefined;
  }
  if (!endpoint || !bucket || !key || !accessKeyFile || !secretKeyFile) {
    throw new Error(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Endpoint}, ${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Bucket}, ${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Key}, ${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3AccessKeyFile}, and ${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3SecretKeyFile} must be set together`,
    );
  }
  let invalidBucket = false;
  for (const character of bucket) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      character === "/" ||
      character === "\\" ||
      /\s/u.test(character) ||
      codePoint < 0x20 ||
      codePoint === 0x7f
    ) {
      invalidBucket = true;
      break;
    }
  }
  if (invalidBucket) {
    throw new Error(`${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Bucket} is invalid`);
  }
  const normalizedKey = key.replace(/^\/+/, "");
  if (!normalizedKey) {
    throw new Error(`${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Key} is empty`);
  }
  const accessKeyId = readDeploymentSecret(
    accessKeyFile,
    PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3AccessKeyFile,
  );
  const secretAccessKey = readDeploymentSecret(
    secretKeyFile,
    PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3SecretKeyFile,
  );
  if (/\s/u.test(accessKeyId)) {
    throw new Error(`${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3AccessKeyFile} is invalid`);
  }
  return {
    endpoint: parseGuideVideoS3Endpoint(endpoint, PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Endpoint),
    region: region || DEFAULT_GUIDE_VIDEO_S3_REGION,
    bucket,
    key: normalizedKey,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: parseOptionalBoolean(
      forcePathStyleRaw,
      PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3ForcePathStyle,
      true,
    ),
  };
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
  const bootstrapPasswordFile =
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubBootstrapPasswordFile]?.trim();
  if (!url && !tokenFile && !namespaceList && !bootstrapPasswordFile) {
    return undefined;
  }
  if (!url || !tokenFile || !namespaceList || !bootstrapPasswordFile) {
    throw new Error(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubUrl}, ${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubTokenFile}, ${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubNamespaces}, and ${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubBootstrapPasswordFile} must be set together`,
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
  const namespaces = [
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
          if (!namespace || (separator !== -1 && !value.slice(separator + 1).trim())) {
            throw new Error(`${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubNamespaces} is invalid`);
          }
          return [namespace, true] as const;
        }),
    ),
  ].map(([namespace]) => namespace);
  if (namespaces.length === 0) {
    throw new Error(`${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubNamespaces} is empty`);
  }
  return {
    url: parsed.toString(),
    token: readDeploymentSecret(tokenFile, PLATFORMCLAW_DEPLOYMENT_ENV.skillHubTokenFile),
    namespaces,
    maxPackageBytes: parsePositiveInteger(
      env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubMaxPackageBytes],
      PLATFORMCLAW_DEPLOYMENT_ENV.skillHubMaxPackageBytes,
      DEFAULT_SKILL_HUB_MAX_PACKAGE_BYTES,
    ),
    bootstrapPassword: readDeploymentSecret(
      bootstrapPasswordFile,
      PLATFORMCLAW_DEPLOYMENT_ENV.skillHubBootstrapPasswordFile,
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

function loadOptionalEmployeeSsoConfig(env: NodeJS.ProcessEnv): EmployeeSsoConfig | undefined {
  const loginUrl = env[PLATFORMCLAW_DEPLOYMENT_ENV.employeeAuthAdSsoUrl]?.trim();
  const secretFile = env[PLATFORMCLAW_DEPLOYMENT_ENV.employeeAuthAdSsoSecretFile]?.trim();
  if (!loginUrl && !secretFile) {
    return undefined;
  }
  if (!loginUrl || !secretFile) {
    throw new Error(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.employeeAuthAdSsoUrl} and ${PLATFORMCLAW_DEPLOYMENT_ENV.employeeAuthAdSsoSecretFile} must be configured together`,
    );
  }
  const handoffSecret = readDeploymentSecret(
    secretFile,
    PLATFORMCLAW_DEPLOYMENT_ENV.employeeAuthAdSsoSecretFile,
  );
  if (Buffer.byteLength(handoffSecret, "utf8") < 32) {
    throw new Error(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.employeeAuthAdSsoSecretFile} must contain at least 32 bytes`,
    );
  }
  return { loginUrl: normalizeEmployeeSsoLoginUrl(loginUrl), handoffSecret };
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
  const publicOrigin = parsePublicOrigin(
    requiredEnv(env, PLATFORMCLAW_DEPLOYMENT_ENV.publicOrigin),
  );
  const guideVideoUrl = parseGuideVideoUrl(env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoUrl]);
  const guideVideoS3 = loadGuideVideoS3Config(env);
  if (guideVideoUrl && guideVideoS3) {
    throw new Error(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoUrl} cannot be combined with private S3 guide video settings`,
    );
  }
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
  if (env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubPrimaryAdminId]?.trim()) {
    throw new Error(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.skillHubPrimaryAdminId} is retired; inactive Skill Hub owners now enter the administrator review queue`,
    );
  }
  const skillHub = loadSkillHubConfig(env);
  const employeeSso = loadOptionalEmployeeSsoConfig(env);
  return {
    publicOrigin,
    ...(guideVideoUrl ? { guideVideoUrl } : {}),
    ...(guideVideoS3 ? { guideVideoS3 } : {}),
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
    ...(employeeSso ? { employeeSso } : {}),
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
    execCredentialCipher: ExecCredentialCipher.fromBase64(credentialMasterKey),
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
