import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  buildSshSandboxArgv,
  disposeSshSandboxSession,
  sanitizeEnvVars,
  shellEscape,
  type SandboxBackendTerminalStream,
  type SandboxBackendTerminalStreamParams,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import { leaseIdentity } from "./ssh-lease-manager.js";
import { TmuxControlParser, type TmuxControlEvent } from "./tmux-control-protocol.js";

const MAX_TABS = 8;
const MAX_PENDING_OUTPUT = 1024 * 1024;
const MAX_PENDING_COMMANDS = 128;
const COMMAND_TIMEOUT_MS = 10_000;
const TMUX_REQUIRED =
  "VM terminal requires tmux 3.2a or newer. Ask your VM administrator to install the approved tmux package, then reopen Terminal.";
type Exit = Parameters<SandboxBackendTerminalStream["onExit"]>[0] extends (exit: infer T) => void
  ? T
  : never;
type TmuxTransport = {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  dispose(): Promise<void>;
};
type OpenTransport = (
  target: AssignedVmTargetSnapshot,
  remoteCommand: string,
) => Promise<TmuxTransport>;
type Command = {
  text: string;
  resolve(lines: string[]): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
};

function dimensions(cols: number, rows: number): void {
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 2000 ||
    rows > 2000
  ) {
    throw new Error("VM terminal dimensions must be between 1 and 2000.");
  }
}

/** Dedicated server and no user tmux config keep control framing and lifecycle owner-controlled. */
export function buildTmuxTerminalCommand(
  target: AssignedVmTargetSnapshot,
  name: string,
  cols: number,
  rows: number,
): string {
  dimensions(cols, rows);
  if (!/^platformclaw-[a-f0-9-]{36}$/u.test(name)) {
    throw new Error("Invalid VM terminal session identity.");
  }
  const setup = [
    "set -eu",
    `command -v tmux >/dev/null 2>&1 || { printf '%s\\n' ${shellEscape(TMUX_REQUIRED)} >&2; exit 127; }`,
    // SSH sets SHELL from the account database; tmux's empty command opens it as a login shell.
    "test -n \"${SHELL:-}\" && test -x \"$SHELL\" || { printf '%s\\n' 'VM account login shell is unavailable; ask your administrator to repair it.' >&2; exit 126; }",
    `cd -- ${shellEscape(target.remoteHomeDir)}`,
    `exec tmux -u -L ${name} -f /dev/null -C new-session -s ${name} -x ${cols} -y ${rows} -c ${shellEscape(target.remoteHomeDir)} \\; set-option destroy-unattached on \\; set-window-option -g window-size manual \\; display-message -p 'platformclaw-ready #{pane_id} #{window_id}'`,
  ].join("; ");
  // Setup stays POSIX for fish/csh accounts; SSH's passwd-derived SHELL is
  // retained so tmux still launches the configured account login shell.
  return `/bin/sh -c ${shellEscape(setup)}`;
}

class TmuxPane implements SandboxBackendTerminalStream {
  private readonly decoder = new StringDecoder("utf8");
  private pending: string[] = [];
  private pendingBytes = 0;
  private paused = false;
  private data?: (data: string) => void;
  private exitCallback?: (exit: Exit) => void;
  private exit?: Exit;
  constructor(
    readonly paneId: string,
    readonly windowId: string,
    private readonly controller: TmuxController,
  ) {}
  write(data: string): void {
    if (this.exit) {
      return;
    }
    const bytes = Buffer.from(data, "utf8");
    if (bytes.length > 64 * 1024) {
      throw new Error("VM terminal input exceeded the limit.");
    }
    // Hex byte arguments bypass tmux command quoting and preserve control characters and UTF-8.
    for (let i = 0; i < bytes.length; i += 1024) {
      const hex = Array.from(bytes.subarray(i, i + 1024), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(" ");
      this.run(`send-keys -H -t ${this.paneId} ${hex}`);
    }
  }
  resize(cols: number, rows: number): void {
    dimensions(cols, rows);
    if (!this.exit) {
      this.run(`resize-window -t ${this.windowId} -x ${cols} -y ${rows}`);
    }
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
    this.flush();
  }
  kill(): void {
    if (!this.exit) {
      void this.controller.closePane(this).catch(() => undefined);
    }
  }
  onData(callback: (data: string) => void): void {
    this.data = callback;
    this.flush();
  }
  onExit(callback: (exit: Exit) => void): void {
    this.exitCallback = callback;
    if (this.exit) {
      callback(this.exit);
    }
  }
  output(bytes: Buffer): void {
    if (this.exit) {
      return;
    }
    const text = this.decoder.write(bytes);
    if (!text) {
      return;
    }
    if (this.data && !this.paused) {
      this.data(text);
      return;
    }
    this.pendingBytes += Buffer.byteLength(text);
    if (this.pendingBytes > MAX_PENDING_OUTPUT) {
      this.finish({ error: "VM terminal output exceeded the reconnect buffer; reopen this tab." });
      void this.controller.closePane(this).catch(() => undefined);
      return;
    }
    this.pending.push(text);
  }
  finish(exit: Exit): void {
    if (this.exit) {
      return;
    }
    const tail = this.decoder.end();
    if (tail && this.data && !this.paused) {
      this.data(tail);
    }
    this.flush();
    this.pending = [];
    this.pendingBytes = 0;
    this.exit = exit;
    this.exitCallback?.(exit);
  }
  private flush(): void {
    if (!this.data || this.paused) {
      return;
    }
    const pending = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const text of pending) {
      this.data(text);
    }
  }
  private run(text: string): void {
    void this.controller.command(text).catch(() => {
      this.finish({ error: "VM terminal command failed; reopen this tab." });
      void this.controller.closePane(this).catch(() => undefined);
    });
  }
}

class TmuxController {
  readonly identity: string;
  private transport?: TmuxTransport;
  private readonly panes = new Map<string, TmuxPane>();
  private readonly early = new Map<string, Buffer[]>();
  private earlyBytes = 0;
  private readonly closedWindows = new Set<string>();
  private readonly closingWindows = new Set<string>();
  private readonly queue: Command[] = [];
  private active?: Command;
  private stopped = false;
  private stopPromise?: Promise<void>;
  private reservations = 0;
  private first?: { paneId: string; windowId: string };
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly startPromise: Promise<void>;
  constructor(
    private readonly target: AssignedVmTargetSnapshot,
    params: SandboxBackendTerminalStreamParams,
    open: OpenTransport,
    private readonly onStop: () => void,
  ) {
    this.identity = leaseIdentity(target);
    this.startPromise = this.start(params, open);
  }
  isAvailable(): boolean {
    return !this.stopped;
  }
  async open(params: SandboxBackendTerminalStreamParams): Promise<SandboxBackendTerminalStream> {
    dimensions(params.cols, params.rows);
    if (this.stopped) {
      throw new Error("VM terminal connection closed; reopen Terminal.");
    }
    if (this.panes.size + this.reservations >= MAX_TABS) {
      throw new Error("Close a VM terminal tab before opening another (maximum 8).");
    }
    this.reservations++;
    try {
      await this.startPromise;
      if (this.stopped) {
        throw new Error("VM terminal connection closed; reopen Terminal.");
      }
      let ids = this.first;
      this.first = undefined;
      if (!ids) {
        const lines = await this.command(
          `new-window -d -t ${this.sessionName()} -c ${shellEscape(this.target.remoteHomeDir)} -P -F '#{pane_id} #{window_id}'`,
        );
        ids = this.parseIds(lines.join("\n"));
      }
      const pane = new TmuxPane(ids.paneId, ids.windowId, this);
      this.panes.set(pane.paneId, pane);
      for (const bytes of this.early.get(pane.paneId) ?? []) {
        this.earlyBytes -= bytes.length;
        pane.output(bytes);
      }
      this.early.delete(pane.paneId);
      if (this.closedWindows.delete(pane.windowId)) {
        this.panes.delete(pane.paneId);
        pane.finish({});
      } else {
        pane.resize(params.cols, params.rows);
      }
      return pane;
    } catch (error) {
      // Unknown creation results cannot be adopted or left as an unowned remote pane.
      await this.stop("VM terminal could not create a pane; reopen Terminal.");
      throw error;
    } finally {
      this.reservations--;
      if (this.panes.size === 0 && this.reservations === 0 && !this.stopped) {
        await this.stop();
      }
    }
  }
  command(text: string): Promise<string[]> {
    if (this.stopped || !this.transport) {
      return Promise.reject(new Error("VM terminal connection is unavailable."));
    }
    if (this.queue.length >= MAX_PENDING_COMMANDS) {
      return Promise.reject(new Error("VM terminal input queue is full; wait before retrying."));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      this.pump();
    });
  }
  async closePane(pane: TmuxPane): Promise<void> {
    if (!this.panes.delete(pane.paneId)) {
      return;
    }
    pane.finish({});
    if (!this.stopped) {
      // Explicit close removes local ownership first; its later notification must
      // not be mistaken for a new pane that exited before adoption.
      this.closingWindows.add(pane.windowId);
      try {
        await this.command(`kill-window -t ${pane.windowId}`);
      } catch {
        await this.stop("VM terminal cleanup failed; reopen Terminal.");
      }
      if (this.panes.size === 0 && this.reservations === 0) {
        await this.stop();
      }
    }
  }
  stop(error?: string): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = this.stopInner(error);
    }
    return this.stopPromise;
  }
  private name = `platformclaw-${randomUUID()}`;
  private sessionName(): string {
    return this.name;
  }
  private async start(
    params: SandboxBackendTerminalStreamParams,
    open: OpenTransport,
  ): Promise<void> {
    try {
      const transport = await open(
        this.target,
        buildTmuxTerminalCommand(this.target, this.sessionName(), params.cols, params.rows),
      );
      this.transport = transport;
      if (this.stopped) {
        transport.child.kill();
        await transport.dispose();
        throw new Error("VM terminal target changed during connection.");
      }
      const ready = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
      const parser = new TmuxControlParser((event) => this.event(event));
      transport.child.stdout.on("data", (chunk: Buffer) => {
        try {
          parser.push(chunk);
        } catch {
          void this.stop("VM terminal control protocol failed; reopen Terminal.");
        }
      });
      // Never relay SSH diagnostics containing private endpoint/account details to browsers.
      transport.child.stderr.resume();
      transport.child.once(
        "error",
        () =>
          void this.stop("VM terminal SSH client failed; verify OpenSSH is installed in Gateway."),
      );
      transport.child.stdin.on(
        "error",
        () => void this.stop("VM terminal connection lost; reopen Terminal."),
      );
      transport.child.once(
        "close",
        (code) =>
          void this.stop(
            code === 127 ? TMUX_REQUIRED : "VM terminal connection closed; reopen Terminal.",
          ),
      );
      const timer = setTimeout(() => void this.stop(TMUX_REQUIRED), COMMAND_TIMEOUT_MS);
      timer.unref();
      try {
        await ready;
      } finally {
        clearTimeout(timer);
        this.readyResolve = undefined;
        this.readyReject = undefined;
      }
    } catch (error) {
      await this.stop(
        "VM terminal could not connect; check your VM connection and reopen Terminal.",
      );
      throw error;
    }
  }
  private parseIds(value: string): { paneId: string; windowId: string } {
    const match = /^(%\d{1,10}) (@\d{1,10})$/u.exec(value);
    if (!match) {
      throw new Error("Invalid VM terminal pane identity.");
    }
    return { paneId: match[1]!, windowId: match[2]! };
  }
  private event(event: TmuxControlEvent): void {
    if (this.stopped) {
      return;
    }
    if (event.kind === "response") {
      if (event.flags === 0) {
        if (event.error) {
          void this.stop(TMUX_REQUIRED);
          return;
        }
        const ready = event.lines.find((line) => line.startsWith("platformclaw-ready "));
        if (ready) {
          this.first = this.parseIds(ready.slice(19));
          this.readyResolve?.();
        }
      } else {
        const active = this.active;
        if (!active) {
          throw new Error("Unexpected VM terminal command response.");
        }
        this.active = undefined;
        clearTimeout(active.timer);
        if (event.error) {
          active.reject(new Error("VM terminal command failed."));
        } else {
          active.resolve(event.lines);
        }
        this.pump();
      }
      return;
    }
    if (event.kind === "output") {
      const pane = this.panes.get(event.paneId);
      if (pane) {
        pane.output(event.data);
      } else if (this.reservations > 0 || this.readyResolve) {
        this.earlyBytes += event.data.length;
        if (
          this.earlyBytes > MAX_PENDING_OUTPUT ||
          (!this.early.has(event.paneId) && this.early.size >= MAX_TABS)
        ) {
          throw new Error("VM terminal initial output exceeded the limit.");
        }
        const pending = this.early.get(event.paneId) ?? [];
        pending.push(event.data);
        this.early.set(event.paneId, pending);
      }
      return;
    }
    if (event.line.startsWith("%exit")) {
      void this.stop("VM terminal connection closed; reopen Terminal.");
      return;
    }
    // tmux 3.2a can notify after unlinking the window (control-notify.c), so
    // both notification forms finalize the native terminal by its owned ID.
    const close = /^%(?:unlinked-)?window-close (@\d{1,10})$/u.exec(event.line);
    if (close) {
      if (this.closingWindows.delete(close[1]!)) {
        return;
      }
      const pane = [...this.panes.values()].find((entry) => entry.windowId === close[1]);
      if (pane) {
        this.panes.delete(pane.paneId);
        pane.finish({});
      } else if (this.reservations > 0 && this.closedWindows.size < MAX_TABS) {
        this.closedWindows.add(close[1]!);
      }
      if (this.panes.size === 0 && this.reservations === 0) {
        void this.stop();
      }
    }
  }
  private pump(): void {
    if (this.active || this.stopped) {
      return;
    }
    const command = this.queue.shift();
    if (!command) {
      return;
    }
    this.active = command;
    command.timer = setTimeout(
      () => void this.stop("VM terminal command timed out; reopen Terminal."),
      COMMAND_TIMEOUT_MS,
    );
    command.timer.unref();
    this.transport!.child.stdin.write(`${command.text}\n`);
  }
  private async stopInner(error?: string): Promise<void> {
    this.stopped = true;
    this.onStop();
    const failure = new Error(error ?? "VM terminal closed.");
    this.readyReject?.(failure);
    for (const command of [this.active, ...this.queue]) {
      if (command) {
        clearTimeout(command.timer);
        command.reject(failure);
      }
    }
    this.active = undefined;
    this.queue.length = 0;
    for (const pane of this.panes.values()) {
      pane.finish(error ? { error } : {});
    }
    this.panes.clear();
    this.early.clear();
    this.earlyBytes = 0;
    this.closedWindows.clear();
    this.closingWindows.clear();
    const transport = this.transport;
    if (transport) {
      // EOF detaches the sole controller; destroy-unattached terminates every owned pane.
      transport.child.stdin.end();
      if (transport.child.exitCode === null && transport.child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            transport.child.kill("SIGKILL");
            resolve();
          }, 2000);
          timer.unref();
          transport.child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      await transport.dispose();
    }
  }
}

/** One long-lived SSH control channel per immutable assigned-VM target, eight native terminals. */
export class VmTmuxTerminalManager {
  private readonly controllers = new Map<string, TmuxController>();
  private disposed = false;
  constructor(private readonly openTransport: OpenTransport) {}
  async open(
    target: AssignedVmTargetSnapshot,
    params: SandboxBackendTerminalStreamParams,
  ): Promise<SandboxBackendTerminalStream> {
    dimensions(params.cols, params.rows);
    const identity = leaseIdentity(target);
    for (;;) {
      if (this.disposed) {
        throw new Error("VM terminal service is stopping.");
      }
      let controller = this.controllers.get(target.agentId);
      if (controller && controller.identity !== identity) {
        await controller.stop("VM terminal target changed; reopen Terminal.");
        // Cleanup can outlive another opener or Gateway shutdown. Reread the
        // owner map instead of overwriting a replacement or creating after dispose.
        continue;
      }
      if (!controller || !controller.isAvailable()) {
        controller = new TmuxController(target, params, this.openTransport, () => {
          if (this.controllers.get(target.agentId) === controller) {
            this.controllers.delete(target.agentId);
          }
        });
        this.controllers.set(target.agentId, controller);
      }
      return await controller.open(params);
    }
  }
  async observeTarget(
    agentId: string,
    target: AssignedVmTargetSnapshot | undefined,
  ): Promise<void> {
    const controller = this.controllers.get(agentId);
    if (controller && (!target || controller.identity !== leaseIdentity(target))) {
      await controller.stop("VM terminal authority changed; reopen Terminal.");
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.controllers.values()].map((controller) => controller.stop()));
  }
}

export function createTmuxSshTransport(
  createSession: (target: AssignedVmTargetSnapshot) => Promise<SshSandboxSession>,
): OpenTransport {
  return async (target, remoteCommand) => {
    const session = await createSession(target);
    try {
      const argv = buildSshSandboxArgv({ session, remoteCommand, tty: false });
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: process.cwd(),
        env: sanitizeEnvVars(process.env).allowed,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      return { child, dispose: async () => await disposeSshSandboxSession(session) };
    } catch (error) {
      await disposeSshSandboxSession(session);
      throw error;
    }
  };
}
