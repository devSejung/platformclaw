import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPlatformClawDeploymentConfig,
  PLATFORMCLAW_DEPLOYMENT_ENV,
} from "./deployment-config.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "platformclaw-deployment-"));
  fixtureRoots.push(root);
  const tokenFile = join(root, "gateway-token");
  const adminFile = join(root, "initial-admins");
  const credentialKeyFile = join(root, "ssh-credential-master-key");
  const executionServiceTokenFile = join(root, "execution-service-token");
  const knoxServiceTokenFile = join(root, "knox-service-token");
  const gatewayServiceIdentityFile = join(root, "gateway-service-identity.pem");
  const employeeAuthAdSsoSecretFile = join(root, "employee-auth-adsso-secret");
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(tokenFile, "test-gateway-token\n", { mode: 0o600 });
  writeFileSync(adminFile, "Person.One\nperson.two,person.one\n", { mode: 0o600 });
  writeFileSync(credentialKeyFile, Buffer.alloc(32, 7).toString("base64"), { mode: 0o600 });
  writeFileSync(executionServiceTokenFile, "e".repeat(32), { mode: 0o600 });
  writeFileSync(knoxServiceTokenFile, "k".repeat(32), { mode: 0o600 });
  writeFileSync(employeeAuthAdSsoSecretFile, "s".repeat(32), { mode: 0o600 });
  writeFileSync(gatewayServiceIdentityFile, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  return {
    [PLATFORMCLAW_DEPLOYMENT_ENV.publicOrigin]: "http://127.0.0.1:19001",
    [PLATFORMCLAW_DEPLOYMENT_ENV.databasePath]: join(root, "state", "control.sqlite"),
    [PLATFORMCLAW_DEPLOYMENT_ENV.controlUiRoot]: join(root, "ui"),
    [PLATFORMCLAW_DEPLOYMENT_ENV.workspaceRoot]: join(root, "workspaces"),
    [PLATFORMCLAW_DEPLOYMENT_ENV.initialAdminAccountIdsFile]: adminFile,
    [PLATFORMCLAW_DEPLOYMENT_ENV.gatewayUrl]: "ws://127.0.0.1:18789",
    [PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile]: tokenFile,
    [PLATFORMCLAW_DEPLOYMENT_ENV.gatewayServiceIdentityFile]: gatewayServiceIdentityFile,
    [PLATFORMCLAW_DEPLOYMENT_ENV.sshCredentialMasterKeyFile]: credentialKeyFile,
    [PLATFORMCLAW_DEPLOYMENT_ENV.credentialBrokerAddress]:
      process.platform === "win32"
        ? String.raw`\\.\pipe\platformclaw-test-broker`
        : join(root, "broker.sock"),
    [PLATFORMCLAW_DEPLOYMENT_ENV.executionServiceTokenFile]: executionServiceTokenFile,
    [PLATFORMCLAW_DEPLOYMENT_ENV.knoxServiceTokenFile]: knoxServiceTokenFile,
    [PLATFORMCLAW_DEPLOYMENT_ENV.employeeAuthAdSsoUrl]: "https://auth.example.test/adsso",
    [PLATFORMCLAW_DEPLOYMENT_ENV.employeeAuthAdSsoSecretFile]: employeeAuthAdSsoSecretFile,
  };
}

function credentialedGuideUrl(): string {
  const url = new URL("https://video.example.test/guide.mp4");
  url.username = "fixture-user";
  url.password = "fixture-password";
  return url.toString();
}

function addGuideVideoS3Credentials(
  env: NodeJS.ProcessEnv,
  content = "AWS_ACCESS_KEY_ID=fixture-access-key\nAWS_SECRET_ACCESS_KEY=fixture-secret-key\n",
): string {
  const root = dirname(env[PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile] ?? "");
  const credentialsFile = join(root, "guide-s3-credentials.env");
  writeFileSync(credentialsFile, content, { mode: 0o600 });
  env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3CredentialsFile] = credentialsFile;
  return credentialsFile;
}

describe("loadPlatformClawDeploymentConfig", () => {
  it("loads paths, bounded secrets, and derived private Gateway endpoints", () => {
    const env = fixtureEnv();
    const vocConfigFile = join(
      dirname(env[PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile] ?? ""),
      "jira-voc.json",
    );
    writeFileSync(
      vocConfigFile,
      JSON.stringify({
        baseUrl: "https://jira.company.example",
        projectKey: "VOC",
        issueType: "Task",
        authorization: "Bearer test",
      }),
    );
    env[PLATFORMCLAW_DEPLOYMENT_ENV.jiraVocConfigFile] = vocConfigFile;
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoUrl] =
      "http://cdn.example.test/guides/platformclaw.mp4?lang=ko";
    const config = loadPlatformClawDeploymentConfig(env);

    expect(config).toMatchObject({
      publicOrigin: "http://127.0.0.1:19001",
      guideVideoUrl: "http://cdn.example.test/guides/platformclaw.mp4?lang=ko",
      jiraVoc: {
        baseUrl: "https://jira.company.example",
        projectKey: "VOC",
        issueType: "Task",
        authorization: "Bearer test",
      },
      employeeSso: {
        loginUrl: "https://auth.example.test/adsso/login",
        handoffSecret: "s".repeat(32),
      },
      listenHost: "127.0.0.1",
      listenPort: 19001,
      initialAdminAccountIds: ["person.one", "person.two"],
      gatewayUrl: "ws://127.0.0.1:18789",
      gatewayAdminRpcUrl: "http://127.0.0.1:18789/api/v1/admin/rpc",
      gatewayAuth: "test-gateway-token",
      gatewayServiceIdentityFile: resolve(
        env[PLATFORMCLAW_DEPLOYMENT_ENV.gatewayServiceIdentityFile] ?? "",
      ),
      credentialBrokerAddress:
        process.platform === "win32"
          ? String.raw`\\.\pipe\platformclaw-test-broker`
          : resolve(env[PLATFORMCLAW_DEPLOYMENT_ENV.credentialBrokerAddress] ?? ""),
      executionServiceToken: "e".repeat(32),
      knoxServiceToken: "k".repeat(32),
    });
    expect(config.databasePath).toBe(resolve(env[PLATFORMCLAW_DEPLOYMENT_ENV.databasePath] ?? ""));
    expect(config.sshCredentialCipher.keyId).toMatch(/^sha256:/u);
    expect(config.mcpCredentialCipher.keyId).toBe(config.sshCredentialCipher.keyId);
  });

  it("rejects an invalid SSH credential master key", () => {
    const env = fixtureEnv();
    const keyPath = env[PLATFORMCLAW_DEPLOYMENT_ENV.sshCredentialMasterKeyFile] ?? "";
    writeFileSync(keyPath, Buffer.alloc(31).toString("base64"));

    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow("must decode to 32 bytes");
  });

  it("fails closed when a required deployment value is missing", () => {
    const env = fixtureEnv();
    delete env[PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile];

    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile} is required`,
    );
  });

  it("rejects a short execution-service token", () => {
    const env = fixtureEnv();
    const tokenPath = env[PLATFORMCLAW_DEPLOYMENT_ENV.executionServiceTokenFile] ?? "";
    writeFileSync(tokenPath, "too-short");

    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow("must contain 32 to 512 bytes");
  });

  it("loads an optional Skill Hub adapter configuration from server-only values", () => {
    const env = fixtureEnv();
    const tokenPath = join(
      resolve(env[PLATFORMCLAW_DEPLOYMENT_ENV.databasePath] ?? "", "..", ".."),
      "skill-hub-token",
    );
    writeFileSync(tokenPath, "skill-hub-service-token", { mode: 0o600 });
    const bootstrapPasswordPath = `${tokenPath}-bootstrap`;
    writeFileSync(bootstrapPasswordPath, "skill-hub-bootstrap-password", { mode: 0o600 });
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubUrl] = "https://skillhub.example.test/registry";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubTokenFile] = tokenPath;
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubNamespaces] =
      "Engineering=ENG-Skill-Publishers, shared=*,engineering=eng-skill-publishers";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubMaxPackageBytes] = "2097152";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubBootstrapPasswordFile] = bootstrapPasswordPath;

    expect(loadPlatformClawDeploymentConfig(env).skillHub).toEqual({
      url: "https://skillhub.example.test/registry",
      token: "skill-hub-service-token",
      namespaces: ["engineering", "shared"],
      maxPackageBytes: 2 * 1024 * 1024,
      bootstrapPassword: "skill-hub-bootstrap-password",
    });
  });

  it("rejects the retired Skill Hub primary-admin fallback", () => {
    const env = fixtureEnv();
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubPrimaryAdminId] = "person.one";
    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow(
      "inactive Skill Hub owners now enter the administrator review queue",
    );
  });

  it("rejects a partial Skill Hub configuration", () => {
    const env = fixtureEnv();
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubUrl] = "https://skillhub.example.test";
    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow("must be set together");
  });

  it("requires both ADSSO settings and a bounded handoff secret", () => {
    const missingSecret = fixtureEnv();
    delete missingSecret[PLATFORMCLAW_DEPLOYMENT_ENV.employeeAuthAdSsoSecretFile];
    expect(() => loadPlatformClawDeploymentConfig(missingSecret)).toThrow(
      "must be configured together",
    );

    const shortSecret = fixtureEnv();
    const secretPath = shortSecret[PLATFORMCLAW_DEPLOYMENT_ENV.employeeAuthAdSsoSecretFile] ?? "";
    writeFileSync(secretPath, "too-short");
    expect(() => loadPlatformClawDeploymentConfig(shortSecret)).toThrow(
      "must contain at least 32 bytes",
    );
  });

  it("keeps the guide video disabled when its deployment value is blank", () => {
    const env = fixtureEnv();
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoUrl] = "   ";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Region] = "us-east-1";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3CredentialsFile] =
      "/run/secrets/default-credentials";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3ForcePathStyle] = "true";

    expect(loadPlatformClawDeploymentConfig(env)).not.toHaveProperty("guideVideoUrl");
    expect(loadPlatformClawDeploymentConfig(env)).not.toHaveProperty("guideVideoS3");
  });

  it("loads private S3 guide settings with server-only credentials and defaults", () => {
    const env = fixtureEnv();
    addGuideVideoS3Credentials(env);
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Endpoint] = "https://s3.internal.example";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Bucket] = "platformclaw-media";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Key] = "/guides/platformclaw-guide.mp4";

    expect(loadPlatformClawDeploymentConfig(env).guideVideoS3).toEqual({
      endpoint: "https://s3.internal.example",
      region: "us-east-1",
      bucket: "platformclaw-media",
      key: "guides/platformclaw-guide.mp4",
      accessKeyId: "fixture-access-key",
      secretAccessKey: "fixture-secret-key",
      forcePathStyle: true,
    });
  });

  it("supports explicit S3 region and virtual-hosted addressing", () => {
    const env = fixtureEnv();
    addGuideVideoS3Credentials(env);
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Endpoint] = "https://s3.example.test";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Region] = "ap-northeast-2";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Bucket] = "guide-media";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Key] = "guide.mp4";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3ForcePathStyle] = "false";

    expect(loadPlatformClawDeploymentConfig(env).guideVideoS3).toMatchObject({
      region: "ap-northeast-2",
      forcePathStyle: false,
    });
  });

  it("rejects partial or conflicting private S3 guide settings", () => {
    const partial = fixtureEnv();
    partial[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Endpoint] = "https://s3.example.test";
    expect(() => loadPlatformClawDeploymentConfig(partial)).toThrow("must be set together");

    const conflict = fixtureEnv();
    addGuideVideoS3Credentials(conflict);
    conflict[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoUrl] = "https://cdn.example.test/guide.mp4";
    conflict[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Endpoint] = "https://s3.example.test";
    conflict[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Bucket] = "guide-media";
    conflict[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Key] = "guide.mp4";
    expect(() => loadPlatformClawDeploymentConfig(conflict)).toThrow(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoUrl} cannot be combined with private S3 guide video settings`,
    );
  });

  it("rejects invalid private S3 endpoint and path-style values", () => {
    const env = fixtureEnv();
    addGuideVideoS3Credentials(env);
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Endpoint] = "https://s3.example.test/path";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Bucket] = "guide-media";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Key] = "guide.mp4";
    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow("must be an HTTP(S) origin");

    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Endpoint] = "https://s3.example.test";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3ForcePathStyle] = "sometimes";
    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow("must be true or false");
  });

  it("rejects malformed or temporary private S3 credential bundles", () => {
    const env = fixtureEnv();
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Endpoint] = "https://s3.example.test";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Bucket] = "guide-media";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoS3Key] = "guide.mp4";

    addGuideVideoS3Credentials(
      env,
      "AWS_ACCESS_KEY_ID=fixture-access-key\nAWS_ACCESS_KEY_ID=duplicate\nAWS_SECRET_ACCESS_KEY=fixture-secret-key\n",
    );
    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow("is invalid");

    addGuideVideoS3Credentials(
      env,
      "AWS_ACCESS_KEY_ID=fixture-access-key\nAWS_SECRET_ACCESS_KEY=fixture-secret-key\nAWS_SESSION_TOKEN=temporary-token\n",
    );
    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow(
      "contains unsupported temporary session credentials",
    );
  });

  it.each([
    "javascript:alert(1)",
    "ftp://video.example.test/guide.mp4",
    credentialedGuideUrl(),
    "not a url",
  ])("rejects unsafe guide video URL %s without echoing it", (value) => {
    const env = fixtureEnv();
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoUrl] = value;

    let error: unknown;
    try {
      loadPlatformClawDeploymentConfig(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoUrl} must be an HTTP(S) URL without embedded credentials`,
    );
    expect((error as Error).message).not.toContain(value);
  });

  it("allows an internal HTTP guide upstream behind an HTTPS login origin", () => {
    const env = fixtureEnv();
    env[PLATFORMCLAW_DEPLOYMENT_ENV.publicOrigin] = "https://platformclaw.example.test";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.guideVideoUrl] = "http://video.example.test/guide.mp4";

    expect(loadPlatformClawDeploymentConfig(env).guideVideoUrl).toBe(
      "http://video.example.test/guide.mp4",
    );
  });

  it.each([
    [PLATFORMCLAW_DEPLOYMENT_ENV.publicOrigin, "http://example.test/path"],
    [PLATFORMCLAW_DEPLOYMENT_ENV.gatewayUrl, "ws://user@example.test"],
    [PLATFORMCLAW_DEPLOYMENT_ENV.listenPort, "70000"],
  ])("rejects invalid %s", (name, value) => {
    const env = fixtureEnv();
    env[name] = value;

    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow();
  });
});
