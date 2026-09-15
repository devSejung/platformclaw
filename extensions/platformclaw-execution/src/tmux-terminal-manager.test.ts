import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import {
  buildTmuxTerminalCommand,
  VmTmuxTerminalManager,
  type TmuxTransport,
} from "./tmux-terminal-manager.js";

const TARGET: AssignedVmTargetSnapshot = {
  kind: "assigned_vm",
  agentId: "person",
  targetId: "vm-target",
  revision: 3,
  allocationId: "allocation",
  credentialRevision: 2,
  vmLabel: "Development VM",
  safeConnectLabel: "SafeConnect",
  endpointHost: "example.test",
  endpointPort: 22,
  adDomain: "example.test",
  adAccount: "person",
  targetAddress: "192.0.2.10",
  linuxAccount: "person",
  remoteHomeDir: "/home/person",
  remoteWorkspaceDir: "/home/person/.platformclaw/workspace",
  hostKeyAlgorithm: "ssh-ed25519",
  hostKeyPublicKey: "test",
  hostKeyFingerprint: "SHA256:test",
  codingAgents: [],
};
const SIZE = { cols: 100, rows: 30, env: {} };

function harness(options: { startupExit?: number } = {}) {
  let exitNextWindow = false;
  const transports: Array<
    Omit<TmuxTransport, "dispose"> & {
      dispose: Mock<() => Promise<void>>;
      output: PassThrough;
      commands: string[];
    }
  > = [];
  const open = vi.fn(async () => {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let number = 10;
    let pane = 0;
    const commands: string[] = [];
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const text = chunk.toString("utf8").trim();
        commands.push(text);
        const id = ++number;
        const lines = text.startsWith("new-window") ? `%${++pane} @${pane}\n` : "";
        const createdPane = pane;
        const exitWindow = Boolean(lines) && exitNextWindow;
        if (lines) {
          exitNextWindow = false;
        }
        setImmediate(() => {
          stdout.write(`%begin 1 ${id} 1\n${lines}%end 1 ${id} 1\n`);
          if (exitWindow) {
            stdout.write(`%unlinked-window-close @${createdPane}\n`);
          }
          const killed = /^kill-window -t (@\d+)$/u.exec(text);
          if (killed) {
            stdout.write(`%unlinked-window-close ${killed[1]}\n`);
          }
        });
        callback();
      },
      final(callback) {
        setImmediate(() => {
          child.exitCode = 0;
          emitter.emit("close", 0);
        });
        callback();
      },
    });
    const child = Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(() => {
        child.exitCode = 0;
        emitter.emit("close", 0);
        return true;
      }),
    });
    const transport = {
      child: child as unknown as TmuxTransport["child"],
      dispose: vi.fn(async () => undefined),
      output: stdout,
      commands,
    };
    transports.push(transport);
    setImmediate(() => {
      if (options.startupExit !== undefined) {
        child.exitCode = options.startupExit;
        emitter.emit("close", options.startupExit);
      } else {
        stdout.write(
          "%begin 1 1 0\n%end 1 1 0\n%begin 1 2 0\nplatformclaw-ready %0 @0\n%end 1 2 0\n%output %0 prompt\\040\n",
        );
      }
    });
    return transport;
  });
  return {
    manager: new VmTmuxTerminalManager(open),
    open,
    transports,
    exitNextWindow: () => {
      exitNextWindow = true;
    },
  };
}

describe("VmTmuxTerminalManager", () => {
  it("opens eight independent panes through one control channel and rejects the ninth", async () => {
    const h = harness();
    const tabs = await Promise.all(Array.from({ length: 8 }, () => h.manager.open(TARGET, SIZE)));
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.transports[0]!.commands.filter((text) => text.startsWith("new-window"))).toHaveLength(
      7,
    );
    await expect(h.manager.open(TARGET, SIZE)).rejects.toThrow("maximum 8");
    const first = vi.fn();
    const second = vi.fn();
    tabs[0]!.onData(first);
    tabs[1]!.onData(second);
    h.transports[0]!.output.write("%output %1 second\\015\\012\n%output %0 first\\033[0m\n");
    expect(first).toHaveBeenLastCalledWith("first\x1b[0m");
    expect(second).toHaveBeenCalledWith("second\r\n");
    tabs[1]!.write("한\r\x03\\;\n");
    tabs[1]!.resize(120, 40);
    await vi.waitFor(() =>
      expect(h.transports[0]!.commands).toContain("resize-window -t @1 -x 120 -y 40"),
    );
    expect(h.transports[0]!.commands).toContain("send-keys -H -t %1 ed 95 9c 0d 03 5c 3b 0a");
    await h.manager.dispose();
    expect(h.transports[0]!.dispose).toHaveBeenCalledOnce();
  });
  it("closes one pane without closing its sibling and reuses the vacant tab slot", async () => {
    const h = harness();
    const first = await h.manager.open(TARGET, SIZE);
    const second = await h.manager.open(TARGET, SIZE);
    const firstExit = vi.fn();
    const secondExit = vi.fn();
    first.onExit(firstExit);
    second.onExit(secondExit);
    first.kill();
    await vi.waitFor(() => expect(h.transports[0]!.commands).toContain("kill-window -t @0"));
    expect(firstExit).toHaveBeenCalledOnce();
    expect(secondExit).not.toHaveBeenCalled();
    await h.manager.open(TARGET, SIZE);
    expect(h.open).toHaveBeenCalledOnce();
    await h.manager.dispose();
  });
  it("buffers paused output with a hard cap and closes only the overflowing pane visibly", async () => {
    const h = harness();
    const first = await h.manager.open(TARGET, SIZE);
    const second = await h.manager.open(TARGET, SIZE);
    const data = vi.fn();
    const exit = vi.fn();
    const siblingExit = vi.fn();
    first.onData(data);
    first.onExit(exit);
    second.onExit(siblingExit);
    first.pause();
    h.transports[0]!.output.write("%output %0 buffered\n");
    expect(data).not.toHaveBeenLastCalledWith("buffered");
    first.resume();
    expect(data).toHaveBeenLastCalledWith("buffered");
    first.pause();
    for (let i = 0; i < 17; i++) {
      h.transports[0]!.output.write(`%output %0 ${"x".repeat(64 * 1024)}\n`);
    }
    expect(exit).toHaveBeenCalledWith({ error: expect.stringContaining("buffer") });
    expect(siblingExit).not.toHaveBeenCalled();
    await h.manager.dispose();
  });
  it("accounts for window exit before adoption after repeated overlapping closes and opens", async () => {
    const h = harness();
    let current = await h.manager.open(TARGET, SIZE);
    const keeper = await h.manager.open(TARGET, SIZE);
    for (let i = 0; i < 10; i++) {
      current.kill();
      current = await h.manager.open(TARGET, SIZE);
    }
    h.exitNextWindow();
    const ended = await h.manager.open(TARGET, SIZE);
    const exit = vi.fn();
    ended.onExit(exit);
    expect(exit).toHaveBeenCalledOnce();
    const keeperExit = vi.fn();
    keeper.onExit(keeperExit);
    expect(keeperExit).not.toHaveBeenCalled();
    await h.manager.dispose();
  });
  it("retires all tabs before a credential change creates another channel", async () => {
    const h = harness();
    const tab = await h.manager.open(TARGET, SIZE);
    const exit = vi.fn();
    tab.onExit(exit);
    await h.manager.observeTarget(TARGET.agentId, { ...TARGET, credentialRevision: 3 });
    expect(exit).toHaveBeenCalledWith({ error: expect.stringContaining("authority changed") });
    expect(h.transports[0]!.dispose).toHaveBeenCalledOnce();
    await h.manager.open({ ...TARGET, credentialRevision: 3 }, SIZE);
    expect(h.open).toHaveBeenCalledTimes(2);
    await h.manager.dispose();
  });
  it.each(["window-close", "unlinked-window-close"])(
    "finalizes a naturally exited owned pane from %s without closing its sibling",
    async (notification) => {
      const h = harness();
      const first = await h.manager.open(TARGET, SIZE);
      const second = await h.manager.open(TARGET, SIZE);
      const firstExit = vi.fn();
      const secondExit = vi.fn();
      first.onExit(firstExit);
      second.onExit(secondExit);
      h.transports[0]!.output.write(`%${notification} @1\n`);
      expect(secondExit).toHaveBeenCalledOnce();
      expect(firstExit).not.toHaveBeenCalled();
      await h.manager.dispose();
    },
  );
  it("reuses a concurrent replacement after the old controller's cleanup finishes", async () => {
    const h = harness();
    await h.manager.open(TARGET, SIZE);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    vi.mocked(h.transports[0]!.dispose).mockImplementationOnce(async () => await cleanup);
    const revised = { ...TARGET, credentialRevision: TARGET.credentialRevision + 1 };
    const first = h.manager.open(revised, SIZE);
    await vi.waitFor(() => expect(h.transports[0]!.dispose).toHaveBeenCalledOnce());
    const second = await h.manager.open(revised, SIZE);
    finishCleanup();
    const resumed = await first;
    expect(h.open).toHaveBeenCalledTimes(2);
    const firstData = vi.fn();
    const secondData = vi.fn();
    resumed.onData(firstData);
    second.onData(secondData);
    h.transports[1]!.output.write("%output %0 second\n%output %1 resumed\n");
    expect(firstData).toHaveBeenCalledWith("resumed");
    expect(secondData).toHaveBeenLastCalledWith("second");
    await Promise.all(Array.from({ length: 6 }, () => h.manager.open(revised, SIZE)));
    await expect(h.manager.open(revised, SIZE)).rejects.toThrow("maximum 8");
    expect(h.open).toHaveBeenCalledTimes(2);
    await h.manager.dispose();
  });
  it("rejects a pending replacement if Gateway shutdown occurs during old cleanup", async () => {
    const h = harness();
    await h.manager.open(TARGET, SIZE);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    vi.mocked(h.transports[0]!.dispose).mockImplementationOnce(async () => await cleanup);
    const revised = { ...TARGET, credentialRevision: TARGET.credentialRevision + 1 };
    const reopen = h.manager.open(revised, SIZE);
    await vi.waitFor(() => expect(h.transports[0]!.dispose).toHaveBeenCalledOnce());
    await h.manager.dispose();
    const rejected = expect(reopen).rejects.toThrow("service is stopping");
    finishCleanup();
    await rejected;
    expect(h.open).toHaveBeenCalledOnce();
  });
  it("surfaces missing tmux without a direct PTY fallback", async () => {
    const h = harness({ startupExit: 127 });
    await expect(h.manager.open(TARGET, SIZE)).rejects.toThrow("requires tmux");
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.transports[0]!.dispose).toHaveBeenCalledOnce();
    await h.manager.dispose();
  });
  it("fails all tabs visibly on malformed control framing and disposes once", async () => {
    const h = harness();
    const tab = await h.manager.open(TARGET, SIZE);
    const exit = vi.fn();
    tab.onExit(exit);
    h.transports[0]!.output.write("%output %0 \\bad\n");
    await vi.waitFor(() => expect(h.transports[0]!.dispose).toHaveBeenCalledOnce());
    expect(exit).toHaveBeenCalledWith({ error: expect.stringContaining("protocol failed") });
    await h.manager.dispose();
  });
  it("uses a dedicated config-free server and immediate remote orphan cleanup", () => {
    const command = buildTmuxTerminalCommand(
      TARGET,
      "platformclaw-12345678-1234-1234-1234-123456789abc",
      100,
      30,
    );
    expect(command).toContain("-f /dev/null -C new-session");
    expect(command).toContain("destroy-unattached on");
    expect(command).toContain("window-size manual");
    expect(command).toMatch(/^\/bin\/sh -c '/u);
    expect(command).toContain('test -x "$SHELL"');
    expect(command).toContain("/home/person");
    expect(() => buildTmuxTerminalCommand(TARGET, "bad;command", 100, 30)).toThrow("identity");
  });
});
