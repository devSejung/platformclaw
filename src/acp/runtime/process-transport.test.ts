import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACP_AGENT_ENV,
  ACP_EXECUTION_OWNER_ENV,
  ACP_SESSION_KEY_ENV,
  canUseAcpProcessTransport,
  launchWithAcpProcessTransport,
  prepareAcpProcessTransport,
  registerAcpProcessTransport,
  releaseAcpProcessTransport,
  testing,
} from "./process-transport.js";

describe("ACP process transport registry", () => {
  afterEach(() => testing.resetAcpProcessTransportsForTests());

  it("pins preparation and launch to the same provider and strips routing markers", async () => {
    const child = {} as ChildProcessByStdio<Writable, Readable, Readable>;
    const launch = vi.fn(async () => child);
    const release = vi.fn(async () => undefined);
    registerAcpProcessTransport({
      id: "vm",
      isolatesSandboxedRequesters: true,
      supports: ({ agent }) => agent === "claude",
      prepare: async () => ({ cwd: "/home/alice/workspace" }),
      launch,
      release,
    });

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
        agentCommand: "ignored-local-command",
        command: "ignored-local-command",
        args: ["--ignored"],
        cwd: "/home/alice/workspace",
        env: {
          SAFE: "kept",
          [ACP_EXECUTION_OWNER_ENV]: "alice",
          [ACP_AGENT_ENV]: "claude",
          [ACP_SESSION_KEY_ENV]: "session-1",
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
    await prepareAcpProcessTransport({
      executionOwnerAgentId: "alice",
      agent: "claude",
      sessionKey: "session-1",
    });
    unregister();

    await expect(
      launchWithAcpProcessTransport({
        agentCommand: "claude",
        command: "claude",
        args: [],
        cwd: "/workspace",
        env: {
          [ACP_EXECUTION_OWNER_ENV]: "alice",
          [ACP_AGENT_ENV]: "claude",
          [ACP_SESSION_KEY_ENV]: "session-1",
        },
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
});
