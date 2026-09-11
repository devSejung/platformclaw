import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canUseAcpProcessTransport,
  diagnoseAcpProcessTransport,
  launchWithAcpProcessTransport,
  prepareAcpProcessTransport,
  registerAcpProcessTransport,
  releaseAcpProcessTransport,
} from "./process-transport.js";

describe("ACP process transport registry", () => {
  const unregisters: Array<() => void> = [];
  afterEach(() => {
    for (const unregister of unregisters.splice(0).toReversed()) {
      unregister();
    }
  });

  it("pins preparation and launch to the same provider with an explicit route", async () => {
    const child = {} as ChildProcessByStdio<Writable, Readable, Readable>;
    const launch = vi.fn(async () => child);
    const release = vi.fn(async () => undefined);
    unregisters.push(
      registerAcpProcessTransport({
        id: "vm",
        isolatesSandboxedRequesters: true,
        supports: ({ agent }) => agent === "claude",
        prepare: async () => ({ cwd: "/home/alice/workspace" }),
        launch,
        release,
      }),
    );

    expect(canUseAcpProcessTransport({ executionOwnerAgentId: "Alice", agent: "claude" })).toBe(
      true,
    );
    await expect(
      prepareAcpProcessTransport({
        executionOwnerAgentId: "Alice",
        agent: "claude",
        sessionKey: "session-1",
      }),
    ).resolves.toEqual({ cwd: "/home/alice/workspace" });

    await expect(
      launchWithAcpProcessTransport({
        route: { executionOwnerAgentId: "alice", agent: "claude", sessionKey: "session-1" },
        agentCommand: "ignored-local-command",
        command: "ignored-local-command",
        args: ["--ignored"],
        cwd: "/home/alice/workspace",
        env: {
          SAFE: "kept",
          OPENCLAW_ACP_EXECUTION_OWNER_AGENT_ID: "mallory",
          OPENCLAW_ACP_AGENT_ID: "spoofed-agent",
          OPENCLAW_ACP_SESSION_KEY: "spoofed-session",
        },
      }),
    ).resolves.toBe(child);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        executionOwnerAgentId: "alice",
        agent: "claude",
        sessionKey: "session-1",
        env: { SAFE: "kept" },
      }),
    );

    await releaseAcpProcessTransport({ executionOwnerAgentId: "ALICE", sessionKey: "session-1" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses launch after its prepared provider is unregistered", async () => {
    const unregister = registerAcpProcessTransport({
      id: "vm",
      isolatesSandboxedRequesters: true,
      supports: () => true,
      prepare: async () => ({ cwd: "/workspace" }),
      launch: vi.fn(),
    });
    unregisters.push(unregister);
    await prepareAcpProcessTransport({
      executionOwnerAgentId: "alice",
      agent: "claude",
      sessionKey: "session-1",
    });
    unregister();

    await expect(
      launchWithAcpProcessTransport({
        route: { executionOwnerAgentId: "alice", agent: "claude", sessionKey: "session-1" },
        agentCommand: "claude",
        command: "claude",
        args: [],
        cwd: "/workspace",
        env: {},
      }),
    ).rejects.toThrow("No isolated ACP process transport");
  });

  it("keeps ordinary local ACP launches outside the transport", async () => {
    await expect(
      launchWithAcpProcessTransport({
        agentCommand: "claude",
        command: "claude",
        args: [],
        cwd: "/workspace",
        env: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("diagnoses through the matching provider without preparing launch state", async () => {
    const diagnose = vi.fn(async () => ({
      ok: true as const,
      stage: "ready" as const,
      code: "ready",
      message: "ready",
    }));
    const launch = vi.fn();
    unregisters.push(
      registerAcpProcessTransport({
        id: "vm",
        isolatesSandboxedRequesters: true,
        supports: ({ agent }) => agent === "claude",
        prepare: vi.fn(async () => ({ cwd: "/workspace" })),
        launch,
        diagnose,
      }),
    );

    await expect(
      diagnoseAcpProcessTransport({
        executionOwnerAgentId: "alice",
        agent: "claude",
        signal: AbortSignal.timeout(100),
      }),
    ).resolves.toEqual({ ok: true, stage: "ready", code: "ready", message: "ready" });
    expect(diagnose).toHaveBeenCalledWith(
      expect.objectContaining({ executionOwnerAgentId: "alice", agent: "claude" }),
    );
    expect(launch).not.toHaveBeenCalled();

    await expect(
      launchWithAcpProcessTransport({
        route: { executionOwnerAgentId: "alice", agent: "claude", sessionKey: "not-prepared" },
        agentCommand: "claude",
        command: "claude",
        args: [],
        cwd: "/workspace",
        env: {},
      }),
    ).rejects.toThrow("No isolated ACP process transport");
    await expect(
      diagnoseAcpProcessTransport({ executionOwnerAgentId: "alice", agent: "opencode" }),
    ).resolves.toBeUndefined();
  });

  it("leaves matching providers without diagnostics unchanged", async () => {
    unregisters.push(
      registerAcpProcessTransport({
        id: "legacy-vm",
        isolatesSandboxedRequesters: true,
        supports: ({ agent }) => agent === "claude",
        prepare: vi.fn(async () => ({ cwd: "/workspace" })),
        launch: vi.fn(),
      }),
    );

    await expect(
      diagnoseAcpProcessTransport({ executionOwnerAgentId: "alice", agent: "claude" }),
    ).resolves.toBeUndefined();
  });
});
