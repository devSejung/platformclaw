import { afterEach, describe, expect, it } from "vitest";
import { registerAcpProcessTransport, testing } from "../acp/runtime/process-transport.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { resolveAcpSpawnRuntimePolicyError } from "./acp-spawn.js";

describe("ACP sandbox runtime policy", () => {
  afterEach(() => {
    unregisterAcpRuntimeBackend("acpx");
    testing.resetAcpProcessTransportsForTests();
  });

  it("allows only target agents owned by the isolated requester transport", () => {
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime: {} as never,
      isolatesSandboxedRequesters: () => true,
    });
    registerAcpProcessTransport({
      id: "assigned-vm",
      isolatesSandboxedRequesters: true,
      supports: ({ agent }) => agent === "claude",
      prepare: async () => ({ cwd: "/home/alice/workspace" }),
      launch: async () => ({}) as never,
    });
    const cfg = { acp: { enabled: true, backend: "acpx" } };

    expect(
      resolveAcpSpawnRuntimePolicyError({
        cfg,
        requesterSandboxed: true,
        executionOwnerAgentId: "alice",
        targetAgentId: "claude",
      }),
    ).toBeUndefined();
    expect(
      resolveAcpSpawnRuntimePolicyError({
        cfg,
        requesterSandboxed: true,
        executionOwnerAgentId: "alice",
        targetAgentId: "codex",
      }),
    ).toContain("Sandboxed sessions cannot spawn ACP sessions");
  });
});
