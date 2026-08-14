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
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(tokenFile, "test-gateway-token\n", { mode: 0o600 });
  writeFileSync(adminFile, "Person.One\nperson.two,person.one\n", { mode: 0o600 });
  writeFileSync(credentialKeyFile, Buffer.alloc(32, 7).toString("base64"), { mode: 0o600 });
  writeFileSync(executionServiceTokenFile, "e".repeat(32), { mode: 0o600 });
  writeFileSync(knoxServiceTokenFile, "k".repeat(32), { mode: 0o600 });
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
  };
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
    const config = loadPlatformClawDeploymentConfig(env);

    expect(config).toMatchObject({
      publicOrigin: "http://127.0.0.1:19001",
      jiraVoc: {
        baseUrl: "https://jira.company.example",
        projectKey: "VOC",
        issueType: "Task",
        authorization: "Bearer test",
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
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubUrl] = "https://skillhub.example.test/registry";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubTokenFile] = tokenPath;
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubNamespaces] =
      "Engineering=ENG-Skill-Publishers, shared=*,engineering=eng-skill-publishers";
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubMaxPackageBytes] = "2097152";

    expect(loadPlatformClawDeploymentConfig(env).skillHub).toEqual({
      url: "https://skillhub.example.test/registry",
      token: "skill-hub-service-token",
      namespacePolicies: [
        { namespace: "engineering", accessGroup: "eng-skill-publishers" },
        { namespace: "shared", accessGroup: "*" },
      ],
      maxPackageBytes: 2 * 1024 * 1024,
    });
  });

  it("rejects a partial Skill Hub configuration", () => {
    const env = fixtureEnv();
    env[PLATFORMCLAW_DEPLOYMENT_ENV.skillHubUrl] = "https://skillhub.example.test";
    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow("must be set together");
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
