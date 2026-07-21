import { describe, expect, it, vi } from "vitest";
import type { PlatformClawDeploymentConfig } from "./deployment-config.js";
import { createPlatformClawDeploymentRuntime } from "./deployment-runtime.js";
import type {
  PlatformClawWebIngressRuntime,
  PlatformClawWebIngressRuntimeOptions,
} from "./web-ingress-runtime.js";

const config: PlatformClawDeploymentConfig = {
  publicOrigin: "http://127.0.0.1:19001",
  listenHost: "127.0.0.1",
  listenPort: 19001,
  databasePath: "/state/platformclaw-control.sqlite",
  controlUiRoot: "/app/ui-dist",
  workspaceRoot: "/state/workspaces",
  initialAdminAccountIds: ["person.one"],
  gatewayUrl: "ws://127.0.0.1:18789",
  gatewayAdminRpcUrl: "http://127.0.0.1:18789/api/v1/admin/rpc",
  gatewayAuth: "test-gateway-token",
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
      controlUiRoot: config.controlUiRoot,
      gatewayClient: {
        client: {
          url: config.gatewayUrl,
          token: config.gatewayAuth,
          role: "operator",
        },
      },
    });
    expect(options?.restartRecoveryProbe).toBe(options?.provisioner);
    expect(options?.buildAgentMainSessionKey({ agentId: "person_one" })).toBe(
      "agent:person_one:main",
    );
    expect(options?.resolveAgentIdFromSessionKey("agent:person_one:main")).toBe("person_one");
    expect(options?.resolveAgentIdFromSessionKey("agent:Person.One:main")).toBeNull();
  });
});
