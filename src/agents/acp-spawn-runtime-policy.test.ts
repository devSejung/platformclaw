import { afterEach, describe, expect, it } from "vitest";
import { registerAcpProcessTransport } from "../acp/runtime/process-transport.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { resolveAcpSpawnRuntimePlan } from "./acp-spawn.js";

describe("ACP sandbox runtime policy", () => {
  let unregisterProcessTransport: (() => void) | undefined;

  afterEach(() => {
    unregisterAcpRuntimeBackend("acpx");
    unregisterProcessTransport?.();
    unregisterProcessTransport = undefined;
  });

  it("allows only target agents owned by the isolated requester transport", () => {
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime: {} as never,
      isolatesSandboxedRequesters: () => true,
    });
    unregisterProcessTransport = registerAcpProcessTransport({
      id: "assigned-vm",
      isolatesSandboxedRequesters: true,
      supports: ({ agent }) => agent === "claude",
      prepare: async () => ({ cwd: "/home/alice/workspace" }),
      launch: async () => ({}) as never,
    });
    const cfg = { acp: { enabled: true, backend: "acpx" } };

    expect(
      resolveAcpSpawnRuntimePlan({
        cfg,
        requesterSandboxed: true,
        executionOwnerAgentId: "alice",
        targetAgentId: "claude",
      }),
    ).toEqual({ ok: true, executionOwnerAgentId: "alice" });
    expect(
      resolveAcpSpawnRuntimePlan({
        cfg,
        requesterSandboxed: true,
        executionOwnerAgentId: "alice",
        targetAgentId: "codex",
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("Sandboxed sessions cannot spawn ACP sessions"),
    });
  });

  it("keeps genuinely local ACP sessions unowned", () => {
    const cfg = { acp: { enabled: true, backend: "acpx" } };

    expect(
      resolveAcpSpawnRuntimePlan({
        cfg,
        executionOwnerAgentId: "alice",
        targetAgentId: "claude",
      }),
    ).toEqual({ ok: true });
  });
});
