import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PlatformClawDeploymentConfig } from "./deployment-config.js";
import { createPlatformClawDeploymentRuntime } from "./deployment-runtime.js";
import { ExecCredentialCipher } from "./exec-credential-crypto.js";
import { McpCredentialCipher } from "./mcp-credential-crypto.js";
import { SshCredentialCipher } from "./ssh-credential-crypto.js";
import type {
  PlatformClawWebIngressRuntime,
  PlatformClawWebIngressRuntimeOptions,
} from "./web-ingress-runtime.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "platformclaw-runtime-"));
const gatewayServiceIdentityFile = join(fixtureRoot, "gateway-service-identity.pem");
const { privateKey } = generateKeyPairSync("ed25519");
writeFileSync(gatewayServiceIdentityFile, privateKey.export({ type: "pkcs8", format: "pem" }), {
  mode: 0o600,
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const config: PlatformClawDeploymentConfig = {
  publicOrigin: "http://127.0.0.1:19001",
  guideVideoUrl: "https://video.example.test/platformclaw-guide.mp4",
  listenHost: "127.0.0.1",
  listenPort: 19001,
  databasePath: "/state/platformclaw-control.sqlite",
  controlUiRoot: "/app/ui-dist",
  jiraVoc: {
    baseUrl: "https://jira.company.example",
    projectKey: "VOC",
    issueType: "Task",
    components: [],
    defaultCoworkers: [],
    authorization: "Bearer test",
  },
  employeeSso: {
    loginUrl: "https://auth.example.test/adsso/login",
    handoffSecret: "s".repeat(32),
  },
  workspaceRoot: "/state/workspaces",
  initialAdminAccountIds: ["person.one"],
  gatewayUrl: "ws://127.0.0.1:18789",
  gatewayAdminRpcUrl: "http://127.0.0.1:18789/api/v1/admin/rpc",
  gatewayAuth: "test-gateway-token",
  gatewayServiceIdentityFile,
  sshCredentialCipher: SshCredentialCipher.fromBase64(Buffer.alloc(32, 7).toString("base64")),
  mcpCredentialCipher: McpCredentialCipher.fromBase64(Buffer.alloc(32, 7).toString("base64")),
  execCredentialCipher: ExecCredentialCipher.fromBase64(Buffer.alloc(32, 7).toString("base64")),
  credentialBrokerAddress: "/run/platformclaw-credential-broker/credential.sock",
  executionServiceToken: "e".repeat(32),
  knoxServiceToken: "k".repeat(32),
};

describe("createPlatformClawDeploymentRuntime", () => {
  it("assembles one process-wide Gateway client and agent-scoped session codec", () => {
    const runtime = {} as PlatformClawWebIngressRuntime;
    const createRuntime = vi.fn(
      (_options: PlatformClawWebIngressRuntimeOptions): PlatformClawWebIngressRuntime => runtime,
    );

    expect(createPlatformClawDeploymentRuntime(config, { createRuntime })).toBe(runtime);
    expect(createRuntime).toHaveBeenCalledOnce();
    const options = createRuntime.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      databasePath: config.databasePath,
      initialAdminAccountIds: config.initialAdminAccountIds,
      publicOrigin: config.publicOrigin,
      guideVideoUrl: config.guideVideoUrl,
      controlUiRoot: config.controlUiRoot,
      jiraVoc: config.jiraVoc,
      employeeSso: config.employeeSso,
      credentialBrokerAddress: config.credentialBrokerAddress,
      executionServiceToken: config.executionServiceToken,
      knoxIngressProxyUrl: "http://127.0.0.1:18789/api/v1/platformclaw/knox/inbound",
      knoxRouting: {
        serviceToken: config.knoxServiceToken,
        roomProvisioner: expect.any(Object),
      },
      gatewayClient: {
        pairing: {
          identity: { deviceId: expect.any(String) },
        },
        client: {
          url: config.gatewayUrl,
          token: config.gatewayAuth,
          role: "operator",
          scopes: [
            "operator.read",
            "operator.write",
            "operator.admin",
            "operator.approvals",
            "operator.questions",
          ],
        },
      },
    });
    expect(options?.adminRpc).toBeDefined();
    expect(options?.restartRecoveryProbe).toBe(options?.provisioner);
    expect(options?.employeeAuth?.sshCredentialCipher).toBe(config.sshCredentialCipher);
    expect(options?.employeeAuth?.mcpCredentialCipher).toBe(config.mcpCredentialCipher);
    expect(options?.buildAgentMainSessionKey({ agentId: "person_one" })).toBe(
      "agent:person_one:main",
    );
    expect(options?.resolveAgentIdFromSessionKey("agent:person_one:main")).toBe("person_one");
    expect(options?.resolveAgentIdFromSessionKey("agent:Person.One:main")).toBeNull();
  });

  it("wires Skill Hub through a server-only adapter", () => {
    const runtime = {} as PlatformClawWebIngressRuntime;
    const createRuntime = vi.fn((_options: PlatformClawWebIngressRuntimeOptions) => runtime);
    createPlatformClawDeploymentRuntime(
      {
        ...config,
        skillHub: {
          url: "https://skillhub.example.test",
          token: "server-only-token",
          namespaces: ["engineering"],
          maxPackageBytes: 1024,
          bootstrapPassword: "server-only-bootstrap-password",
        },
      },
      { createRuntime },
    );

    expect(createRuntime.mock.calls[0]?.[0].skillHub).toMatchObject({
      workspaceRoot: config.workspaceRoot,
      allowedNamespaces: ["engineering"],
      maxPackageBytes: 1024,
      adapter: expect.any(Object),
      governance: expect.any(Object),
    });
    expect(createRuntime.mock.calls[0]?.[0].skillHub).not.toHaveProperty("token");
    expect(createRuntime.mock.calls[0]?.[0].skillHub).not.toHaveProperty("bootstrapPassword");
  });

  it("turns private S3 guide credentials into server-only signed media requests", () => {
    const runtime = {} as PlatformClawWebIngressRuntime;
    const createRuntime = vi.fn((_options: PlatformClawWebIngressRuntimeOptions) => runtime);
    const { guideVideoUrl: _directGuide, ...withoutDirectGuide } = config;
    createPlatformClawDeploymentRuntime(
      {
        ...withoutDirectGuide,
        guideVideoS3: {
          endpoint: "https://s3.internal.example",
          region: "us-east-1",
          bucket: "platformclaw-media",
          key: "guides/guide.mp4",
          accessKeyId: "fixture-access",
          secretAccessKey: "fixture-secret",
          forcePathStyle: true,
        },
      },
      { createRuntime },
    );

    const options = createRuntime.mock.calls[0]?.[0];
    expect(options?.guideVideoUrl).toBe(
      "https://s3.internal.example/platformclaw-media/guides/guide.mp4",
    );
    expect(options?.guideVideoRequestHeaders).toEqual(expect.any(Function));
    const target = new URL(options?.guideVideoUrl ?? "https://invalid.example");
    const signed = options?.guideVideoRequestHeaders?.({
      method: "GET",
      target,
      range: "bytes=0-99",
    });
    expect(signed?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=fixture-access\//u);
    expect(JSON.stringify(options)).not.toContain("fixture-secret");
  });
});
