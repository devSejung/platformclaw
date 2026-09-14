import { beforeEach, describe, expect, it, vi } from "vitest";
import * as acpRuntimeRegistry from "../../acp/runtime/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { spawnVisibleAcpSession } from "./sessions-spawn-visible-acp.js";

function visibleAcpConfig(): OpenClawConfig {
  return {
    acp: { enabled: true, backend: "acpx", allowedAgents: ["claude"] },
    agents: {
      list: [
        { id: "main", subagents: { allowAgents: ["claude-worker"] } },
        { id: "claude-worker", runtime: { type: "acp", acp: { agent: "claude" } } },
      ],
    },
  } as OpenClawConfig;
}

describe("visible persistent ACP spawn", () => {
  beforeEach(() => {
    acpRuntimeRegistry.testing.resetAcpRuntimeBackendsForTests();
    acpRuntimeRegistry.registerAcpRuntimeBackend({
      id: "acpx",
      runtime: {
        ensureSession: vi.fn(async (input) => ({
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: "test-acp",
        })),
        async *runTurn() {},
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
    });
  });

  it("accepts mode=run as the task envelope while creating one persistent logical dashboard key", async () => {
    const callGateway = vi.fn(
      async <T = Record<string, unknown>>(
        _method: string,
        _params: Record<string, unknown>,
      ): Promise<T> =>
        ({
          key: "agent:claude-worker:dashboard:child",
          sessionId: "visible-session",
          lifecycleRevision: "visible-revision",
          runStarted: true,
          runId: "run-visible-acp",
        }) as T,
    );
    const registerRun = vi.fn();

    const result = await spawnVisibleAcpSession({
      raw: { runtime: "acp", visible: true, mode: "run" },
      task: "review the change",
      taskName: "review-change",
      label: "Review change",
      requestedAgentId: "claude-worker",
      sandbox: "inherit",
      options: {
        agentSessionKey: "agent:main:main",
        completionOwnerKey: "agent:main:main",
        config: visibleAcpConfig(),
        callGateway,
        registerRun,
        countActiveRuns: () => 0,
      },
    });

    expect(result).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:claude-worker:dashboard:child",
      runId: "run-visible-acp",
      mode: "run",
      cleanup: "keep",
    });
    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        agentId: "claude-worker",
        label: "Review change",
        task: "review the change",
        parentSessionKey: "agent:main:main",
        spawnDepth: 1,
      }),
    );
    expect(registerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionKey: "agent:claude-worker:dashboard:child",
        runId: "run-visible-acp",
        agentId: "claude-worker",
        cleanup: "keep",
        spawnMode: "run",
      }),
    );
  });

  it("rejects conflicting visible ACP mode values", async () => {
    await expect(
      spawnVisibleAcpSession({
        raw: { runtime: "acp", visible: true, mode: "session" },
        task: "review",
        label: "",
        requestedAgentId: "claude-worker",
        sandbox: "inherit",
        options: {
          agentSessionKey: "agent:main:main",
          config: visibleAcpConfig(),
          callGateway: vi.fn(),
          countActiveRuns: () => 0,
        },
      }),
    ).rejects.toThrow('accepts only the spawned-task envelope mode="run"');
  });

  it("uses exact create lifecycle ids for failure cleanup so a replacement row is never key-deleted", async () => {
    const callGateway = vi.fn(
      async <T = Record<string, unknown>>(
        method: string,
        _params: Record<string, unknown>,
      ): Promise<T> => {
        if (method === "sessions.create") {
          return {
            key: "agent:claude-worker:dashboard:child",
            sessionId: "created-session",
            lifecycleRevision: "created-revision",
            runStarted: false,
            runError: "first turn rejected",
          } as T;
        }
        if (method === "sessions.delete") {
          return { ok: true, deleted: true } as T;
        }
        return {} as T;
      },
    );

    const result = await spawnVisibleAcpSession({
      raw: { runtime: "acp", visible: true },
      task: "review",
      label: "",
      requestedAgentId: "claude-worker",
      sandbox: "inherit",
      options: {
        agentSessionKey: "agent:main:main",
        config: visibleAcpConfig(),
        callGateway,
        countActiveRuns: () => 0,
      },
    });

    expect(result).toMatchObject({ status: "error", error: "first turn rejected" });
    expect(callGateway).toHaveBeenCalledWith("sessions.delete", {
      key: "agent:claude-worker:dashboard:child",
      expectedSessionId: "created-session",
      expectedLifecycleRevision: "created-revision",
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
  });

  it("keeps the row instead of performing unsafe key-only cleanup when lifecycle ids are absent", async () => {
    const callGateway = vi.fn(
      async <T = Record<string, unknown>>(
        method: string,
        _params: Record<string, unknown>,
      ): Promise<T> => {
        if (method === "sessions.create") {
          return {
            key: "agent:claude-worker:dashboard:child",
            runStarted: false,
            runError: "legacy response",
          } as T;
        }
        return {} as T;
      },
    );

    const result = await spawnVisibleAcpSession({
      raw: { runtime: "acp", visible: true },
      task: "review",
      label: "",
      requestedAgentId: "claude-worker",
      sandbox: "inherit",
      options: {
        agentSessionKey: "agent:main:main",
        config: visibleAcpConfig(),
        callGateway,
        countActiveRuns: () => 0,
      },
    });

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("Exact session cleanup was not confirmed"),
    });
    expect(callGateway.mock.calls.some(([method]) => method === "sessions.delete")).toBe(false);
  });

  it("rejects raw harness ids so visible sessions always have a configured logical owner", async () => {
    const callGateway = vi.fn();
    const cfg = {
      acp: { enabled: true, backend: "acpx", allowedAgents: ["claude"] },
      agents: { list: [{ id: "main", subagents: { allowAgents: ["*"] } }] },
    } as OpenClawConfig;

    const result = await spawnVisibleAcpSession({
      raw: { runtime: "acp", visible: true },
      task: "review",
      label: "",
      requestedAgentId: "claude",
      sandbox: "inherit",
      options: {
        agentSessionKey: "agent:main:main",
        config: cfg,
        callGateway,
        countActiveRuns: () => 0,
      },
    });

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("must name a configured agent"),
    });
    expect(callGateway).not.toHaveBeenCalled();
  });
});
