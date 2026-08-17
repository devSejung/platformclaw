import { describe, expect, it, vi } from "vitest";
import { createSandboxTerminalBackend } from "./sandbox-backend.js";

describe("createSandboxTerminalBackend", () => {
  it("spawns the backend process and releases it exactly once on exit and kill", async () => {
    const dispose = vi.fn(async () => undefined);
    let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const spawn = vi.fn(async () => ({
      pid: 42,
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: (listener: typeof exit) => {
        exit = listener;
      },
    }));
    const backend = await createSandboxTerminalBackend({
      plan: {
        shell: "person_one login shell",
        cwd: "/home/person_one",
        createProcess: async () => ({
          file: "ssh",
          args: ["-tt", "platformclaw-target"],
          cwd: "/gateway",
          env: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
          dispose,
        }),
      },
      cols: 100,
      rows: 30,
      env: { TERM: "xterm-256color" },
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith({
      file: "ssh",
      args: ["-tt", "platformclaw-target"],
      cwd: "/gateway",
      env: { TERM: "xterm-256color", SSH_AUTH_SOCK: "/tmp/agent.sock" },
      cols: 100,
      rows: 30,
    });
    const onExit = vi.fn();
    backend.onExit(onExit);
    exit?.({ exitCode: 0 });
    backend.kill();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0 });
  });

  it("releases the backend process when PTY spawn fails", async () => {
    const dispose = vi.fn(async () => undefined);
    await expect(
      createSandboxTerminalBackend({
        plan: {
          shell: "login shell",
          cwd: "/home/person_one",
          createProcess: async () => ({ file: "ssh", args: [], cwd: "/gateway", dispose }),
        },
        cols: 80,
        rows: 24,
        env: {},
        spawn: async () => {
          throw new Error("spawn failed");
        },
      }),
    ).rejects.toThrow("spawn failed");
    expect(dispose).toHaveBeenCalledOnce();
  });
});
