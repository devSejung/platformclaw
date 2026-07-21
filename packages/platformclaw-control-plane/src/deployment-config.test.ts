import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  writeFileSync(tokenFile, "test-gateway-token\n", { mode: 0o600 });
  writeFileSync(adminFile, "Person.One\nperson.two,person.one\n", { mode: 0o600 });
  return {
    [PLATFORMCLAW_DEPLOYMENT_ENV.publicOrigin]: "http://127.0.0.1:19001",
    [PLATFORMCLAW_DEPLOYMENT_ENV.databasePath]: join(root, "state", "control.sqlite"),
    [PLATFORMCLAW_DEPLOYMENT_ENV.controlUiRoot]: join(root, "ui"),
    [PLATFORMCLAW_DEPLOYMENT_ENV.workspaceRoot]: join(root, "workspaces"),
    [PLATFORMCLAW_DEPLOYMENT_ENV.initialAdminAccountIdsFile]: adminFile,
    [PLATFORMCLAW_DEPLOYMENT_ENV.gatewayUrl]: "ws://127.0.0.1:18789",
    [PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile]: tokenFile,
  };
}

describe("loadPlatformClawDeploymentConfig", () => {
  it("loads paths, bounded secrets, and derived private Gateway endpoints", () => {
    const env = fixtureEnv();
    const config = loadPlatformClawDeploymentConfig(env);

    expect(config).toMatchObject({
      publicOrigin: "http://127.0.0.1:19001",
      listenHost: "127.0.0.1",
      listenPort: 19001,
      initialAdminAccountIds: ["person.one", "person.two"],
      gatewayUrl: "ws://127.0.0.1:18789",
      gatewayAdminRpcUrl: "http://127.0.0.1:18789/api/v1/admin/rpc",
      gatewayAuth: "test-gateway-token",
    });
    expect(config.databasePath).toBe(resolve(env[PLATFORMCLAW_DEPLOYMENT_ENV.databasePath] ?? ""));
  });

  it("fails closed when a required deployment value is missing", () => {
    const env = fixtureEnv();
    delete env[PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile];

    expect(() => loadPlatformClawDeploymentConfig(env)).toThrow(
      `${PLATFORMCLAW_DEPLOYMENT_ENV.gatewayAuthFile} is required`,
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
