import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeEnvVars, type SshSandboxSession } from "openclaw/plugin-sdk/sandbox";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import { PlatformClawVmAuthenticationError } from "./connection-errors.js";

const DEFAULT_MAX_CHANNELS = 4;
const DEFAULT_MAX_QUEUED_CHANNELS = 256;
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;
const MASTER_READY_TIMEOUT_MS = 15_000;
const MASTER_STOP_TIMEOUT_MS = 2_000;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

type MasterExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export type SafeConnectMasterHandle = {
  isRunning(): boolean;
  onExit(listener: (exit: MasterExit) => void): void;
  stop(): Promise<void>;
};

export type SafeConnectSshLeaseManagerOptions = {
  createAuthenticatedSession: (target: AssignedVmTargetSnapshot) => Promise<SshSandboxSession>;
  createMultiplexedSession: (
    target: AssignedVmTargetSnapshot,
    controlPath: string,
  ) => Promise<SshSandboxSession>;
  startMaster?: (params: {
    session: SshSandboxSession;
    controlPath: string;
  }) => Promise<SafeConnectMasterHandle>;
  disposeSession: (session: SshSandboxSession) => Promise<void>;
  logTiming?: (message: string) => void;
  now?: () => number;
  maxChannels?: number;
  maxQueuedChannels?: number;
  idleTtlMs?: number;
};

type ChannelWaiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  queuedAt: number;
};

function leaseIdentity(target: AssignedVmTargetSnapshot): string {
  return JSON.stringify([
    target.agentId,
    target.allocationId,
    target.revision,
    target.credentialRevision,
    target.endpointHost,
    target.endpointPort,
    target.adDomain,
    target.adAccount,
    target.targetAddress,
    target.linuxAccount,
    target.hostKeyAlgorithm,
    target.hostKeyPublicKey,
    target.hostKeyFingerprint,
  ]);
}

function timingMs(now: () => number, startedAt: number): number {
  return Math.max(0, Math.round((now() - startedAt) * 10) / 10);
}

function boundedOutput(current: string, chunk: Buffer): string {
  if (current.length >= MAX_DIAGNOSTIC_BYTES) {
    return current;
  }
  return (current + chunk.toString("utf8")).slice(0, MAX_DIAGNOSTIC_BYTES);
}

function waitForExit(child: ChildProcess): Promise<MasterExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function runControlCheck(configPath: string, controlPath: string, host: string) {
  const child = spawn("ssh", ["-F", configPath, "-S", controlPath, "-O", "check", host], {
    env: sanitizeEnvVars(process.env).allowed,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = boundedOutput(stderr, chunk);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 1_000);
  timeout.unref();
  const exit = await waitForExit(child).finally(() => clearTimeout(timeout));
  if (exit.error) {
    throw exit.error;
  }
  return { ...exit, stderr };
}

export async function startSafeConnectMaster(params: {
  session: SshSandboxSession;
  controlPath: string;
}): Promise<SafeConnectMasterHandle> {
  await fs.rm(params.controlPath, { force: true });
  const child = spawn(
    params.session.command,
    [
      "-F",
      params.session.configPath,
      "-M",
      "-N",
      "-o",
      "ControlMaster=yes",
      "-o",
      "ControlPersist=no",
      "-o",
      `ControlPath=${params.controlPath}`,
      params.session.host,
    ],
    {
      env: sanitizeEnvVars(process.env).allowed,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnostic = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    diagnostic = boundedOutput(diagnostic, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostic = boundedOutput(diagnostic, chunk);
  });
  let childError: Error | undefined;
  child.once("error", (error) => {
    childError = error;
  });
  const exitPromise = waitForExit(child);
  const deadline = Date.now() + MASTER_READY_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (childError) {
        throw childError;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const exit = await exitPromise;
        if (exit.code === 5) {
          throw new PlatformClawVmAuthenticationError();
        }
        throw new Error(
          `SafeConnect SSH master exited before ready (${String(exit.code ?? exit.signal ?? "unknown")}): ${diagnostic.trim()}`,
        );
      }
      const check = await runControlCheck(
        params.session.configPath,
        params.controlPath,
        params.session.host,
      );
      if (check.code === 0) {
        const listeners = new Set<(exit: MasterExit) => void>();
        let settledExit: MasterExit | undefined;
        void exitPromise.then((exit) => {
          settledExit = exit;
          for (const listener of listeners) {
            listener(exit);
          }
          listeners.clear();
        });
        return {
          isRunning: () => child.exitCode === null && child.signalCode === null,
          onExit: (listener) => {
            if (settledExit) {
              queueMicrotask(() => listener(settledExit!));
            } else {
              listeners.add(listener);
            }
          },
          stop: async () => {
            if (child.exitCode !== null || child.signalCode !== null) {
              return;
            }
            child.kill("SIGTERM");
            const forceTimer = setTimeout(() => child.kill("SIGKILL"), MASTER_STOP_TIMEOUT_MS);
            forceTimer.unref();
            try {
              await exitPromise;
            } finally {
              clearTimeout(forceTimer);
            }
          },
        };
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    throw new Error("SafeConnect SSH master authentication timed out");
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exitPromise.catch(() => undefined);
    throw error;
  }
}

class SafeConnectSshLease {
  private master?: SafeConnectMasterHandle;
  private masterSession?: SshSandboxSession;
  private connectPromise?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private activeChannels = 0;
  private readonly waiters: ChannelWaiter[] = [];
  private retired = false;
  private closed = false;
  private connectedAt = 0;
  private closePromise?: Promise<void>;

  constructor(
    readonly identity: string,
    private readonly target: AssignedVmTargetSnapshot,
    private readonly options: Required<
      Pick<
        SafeConnectSshLeaseManagerOptions,
        "idleTtlMs" | "maxChannels" | "maxQueuedChannels" | "now" | "startMaster"
      >
    > &
      Pick<
        SafeConnectSshLeaseManagerOptions,
        "createAuthenticatedSession" | "createMultiplexedSession" | "disposeSession" | "logTiming"
      >,
  ) {}

  async createSession(): Promise<SshSandboxSession> {
    const release = await this.acquireChannel();
    try {
      const reused = this.master?.isRunning() === true;
      const startedAt = this.options.now();
      await this.ensureMaster();
      const session = await this.options.createMultiplexedSession(this.target, this.controlPath());
      let released = false;
      session.onDispose = async () => {
        if (released) {
          return;
        }
        released = true;
        release();
      };
      this.options.logTiming?.(
        `event=platformclaw_ssh_lease status=ok reused=${String(reused)} acquireMs=${String(timingMs(this.options.now, startedAt))} masterAgeMs=${String(Math.max(0, Math.round(this.options.now() - this.connectedAt)))} activeChannels=${String(this.activeChannels)} queuedChannels=${String(this.waiters.length)}`,
      );
      return session;
    } catch (error) {
      release();
      throw error;
    }
  }

  retire(reason: string): void {
    if (this.retired) {
      return;
    }
    this.retired = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error("SafeConnect SSH lease changed while waiting for capacity"));
    }
    if (this.activeChannels === 0) {
      void this.close(reason);
    }
  }

  isAvailable(): boolean {
    return !this.retired && !this.closed;
  }

  async close(reason: string): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
    this.closePromise = this.closeInner(reason);
    return await this.closePromise;
  }

  private async closeInner(reason: string): Promise<void> {
    this.closed = true;
    this.retired = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error("SafeConnect SSH lease closed"));
    }
    await this.connectPromise?.catch(() => undefined);
    await this.stopMaster();
    this.options.logTiming?.(`event=platformclaw_ssh_lease_closed reason=${reason}`);
  }

  private controlPath(): string {
    if (!this.masterSession) {
      throw new Error("SafeConnect SSH master session is unavailable");
    }
    return path.join(path.dirname(this.masterSession.configPath), "control.sock");
  }

  private async acquireChannel(): Promise<() => void> {
    if (this.retired || this.closed) {
      throw new Error("SafeConnect SSH lease is unavailable");
    }
    if (this.activeChannels < this.options.maxChannels) {
      this.activeChannels += 1;
      return this.releaseFactory();
    }
    if (this.waiters.length >= this.options.maxQueuedChannels) {
      throw new Error("SafeConnect SSH channel queue capacity reached");
    }
    return await new Promise<() => void>((resolve, reject) => {
      this.waiters.push({ resolve, reject, queuedAt: this.options.now() });
    });
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.releaseChannel();
    };
  }

  private releaseChannel(): void {
    this.activeChannels = Math.max(0, this.activeChannels - 1);
    const waiter = this.retired ? undefined : this.waiters.shift();
    if (waiter) {
      this.activeChannels += 1;
      this.options.logTiming?.(
        `event=platformclaw_ssh_channel_queue status=admitted waitMs=${String(timingMs(this.options.now, waiter.queuedAt))} queuedChannels=${String(this.waiters.length)}`,
      );
      waiter.resolve(this.releaseFactory());
      return;
    }
    if (this.retired) {
      if (this.activeChannels === 0) {
        void this.close("retired");
      }
      return;
    }
    this.scheduleIdleClose();
  }

  private async ensureMaster(): Promise<void> {
    if (this.master?.isRunning()) {
      return;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }
    const startedAt = this.options.now();
    this.connectPromise = this.connectMaster();
    try {
      await this.connectPromise;
      this.options.logTiming?.(
        `event=platformclaw_ssh_master status=connected durationMs=${String(timingMs(this.options.now, startedAt))}`,
      );
    } catch (error) {
      this.options.logTiming?.(
        `event=platformclaw_ssh_master status=failed durationMs=${String(timingMs(this.options.now, startedAt))}`,
      );
      throw error;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async connectMaster(): Promise<void> {
    await this.stopMaster();
    if (this.retired || this.closed) {
      throw new Error("SafeConnect SSH lease is unavailable");
    }
    const session = await this.options.createAuthenticatedSession(this.target);
    this.masterSession = session;
    try {
      const controlPath = this.controlPath();
      const master = await this.options.startMaster({ session, controlPath });
      if (this.retired || this.closed) {
        await master.stop();
        throw new Error("SafeConnect SSH lease changed during authentication");
      }
      this.master = master;
      this.connectedAt = this.options.now();
      master.onExit((exit) => {
        if (this.master === master) {
          this.master = undefined;
          this.options.logTiming?.(
            `event=platformclaw_ssh_master status=disconnected lifetimeMs=${String(Math.max(0, Math.round(this.options.now() - this.connectedAt)))} exit=${String(exit.code ?? exit.signal ?? "unknown")}`,
          );
          void this.disposeMasterSession(session);
        }
      });
    } catch (error) {
      await this.disposeMasterSession(session);
      throw error;
    }
  }

  private async stopMaster(): Promise<void> {
    const master = this.master;
    const session = this.masterSession;
    this.master = undefined;
    this.masterSession = undefined;
    try {
      await master?.stop();
    } finally {
      if (session) {
        await this.options.disposeSession(session);
      }
    }
  }

  private async disposeMasterSession(session: SshSandboxSession): Promise<void> {
    if (this.masterSession !== session) {
      return;
    }
    this.masterSession = undefined;
    await this.options.disposeSession(session);
  }

  private scheduleIdleClose(): void {
    if (this.activeChannels > 0 || !this.master?.isRunning()) {
      return;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    // The lease is renewed by use and is process-local. A full idle day avoids
    // repeated human authentication while still bounding orphaned connections.
    this.idleTimer = setTimeout(() => void this.close("idle_timeout"), this.options.idleTtlMs);
    this.idleTimer.unref();
  }
}

export class SafeConnectSshLeaseManager {
  private readonly leases = new Map<string, SafeConnectSshLease>();
  private readonly options: ConstructorParameters<typeof SafeConnectSshLease>[2];

  constructor(options: SafeConnectSshLeaseManagerOptions) {
    const maxChannels = options.maxChannels ?? DEFAULT_MAX_CHANNELS;
    const maxQueuedChannels = options.maxQueuedChannels ?? DEFAULT_MAX_QUEUED_CHANNELS;
    const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    if (!Number.isSafeInteger(maxChannels) || maxChannels < 1 || maxChannels > 8) {
      throw new Error("SafeConnect SSH max channels must be 1 to 8");
    }
    if (
      !Number.isSafeInteger(maxQueuedChannels) ||
      maxQueuedChannels < 1 ||
      maxQueuedChannels > 4_096
    ) {
      throw new Error("SafeConnect SSH queued channels must be 1 to 4096");
    }
    if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs < 60_000) {
      throw new Error("SafeConnect SSH idle TTL must be at least one minute");
    }
    this.options = {
      ...options,
      maxChannels,
      maxQueuedChannels,
      idleTtlMs,
      now: options.now ?? Date.now,
      startMaster: options.startMaster ?? startSafeConnectMaster,
    };
  }

  observeTarget(agentId: string, target: AssignedVmTargetSnapshot | undefined): void {
    if (!target) {
      const current = this.leases.get(agentId);
      if (current) {
        this.leases.delete(agentId);
        current.retire("target_changed");
      }
      return;
    }
    const current = this.leases.get(target.agentId);
    if (current && current.identity !== leaseIdentity(target)) {
      this.leases.delete(target.agentId);
      current.retire("target_changed");
    }
  }

  async createSession(target: AssignedVmTargetSnapshot): Promise<SshSandboxSession> {
    if (!Number.isSafeInteger(target.credentialRevision) || target.credentialRevision < 1) {
      throw new Error("assigned VM credential revision is unavailable");
    }
    const identity = leaseIdentity(target);
    let lease = this.leases.get(target.agentId);
    if (!lease || lease.identity !== identity || !lease.isAvailable()) {
      lease?.retire("target_changed");
      lease = new SafeConnectSshLease(identity, target, this.options);
      this.leases.set(target.agentId, lease);
    }
    return await lease.createSession();
  }

  async dispose(): Promise<void> {
    const leases = [...this.leases.values()];
    this.leases.clear();
    await Promise.allSettled(leases.map(async (lease) => await lease.close("gateway_stop")));
  }
}
