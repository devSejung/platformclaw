import type { SshSandboxSession } from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it, vi } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import { PlatformClawVmAuthenticationError } from "./connection-errors.js";
import type { PlatformClawExecutionTargetSnapshot } from "./execution-target.types.js";
import { SafeConnectSshLeaseManager } from "./ssh-lease-manager.js";

type StartMaster = NonNullable<
  ConstructorParameters<typeof SafeConnectSshLeaseManager>[0]["startMaster"]
>;
type SafeConnectMasterHandle = Awaited<ReturnType<StartMaster>>;

const TARGET: AssignedVmTargetSnapshot = {
  kind: "assigned_vm",
  agentId: "agent-1",
  targetId: "allocation-1",
  revision: 4,
  allocationId: "allocation-1",
  credentialRevision: 3,
  vmLabel: "Development VM",
  safeConnectLabel: "Safe host",
  endpointHost: "safe.example.test",
  endpointPort: 22,
  adDomain: "example.test",
  adAccount: "employee",
  targetAddress: "192.0.2.10",
  linuxAccount: "employee",
  remoteHomeDir: "/users/employee",
  remoteWorkspaceDir: "/users/employee/.platformclaw/workspace",
  hostKeyAlgorithm: "ssh-ed25519",
  hostKeyPublicKey: "AAAA-test",
  hostKeyFingerprint: "SHA256:test",
  codingAgents: [],
};

function session(index: number): SshSandboxSession {
  return {
    command: "ssh",
    configPath: `/tmp/session-${index}/config`,
    host: "platformclaw-safeconnect",
  };
}

function createHarness(
  options: {
    maxChannels?: number;
    maxQueuedChannels?: number;
    onAuthenticationFailure?: (target: AssignedVmTargetSnapshot) => Promise<void>;
  } = {},
) {
  let nextSession = 0;
  const handles: Array<
    SafeConnectMasterHandle & {
      exit(): void;
      stopped: boolean;
    }
  > = [];
  const createAuthenticatedSession = vi.fn(async () => session(++nextSession));
  const createMultiplexedSession = vi.fn(async () => session(++nextSession));
  const disposeSession = vi.fn(async () => undefined);
  let currentTarget: PlatformClawExecutionTargetSnapshot = TARGET;
  const resolveCurrentTarget = vi.fn(async () => currentTarget);
  const startMaster = vi.fn(async () => {
    let running = true;
    const listeners: Array<(exit: { code: number | null; signal: NodeJS.Signals | null }) => void> =
      [];
    const handle = {
      get stopped() {
        return !running;
      },
      isRunning: () => running,
      onExit: (listener: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void) =>
        listeners.push(listener),
      stop: vi.fn(async () => {
        running = false;
      }),
      exit: () => {
        running = false;
        for (const listener of listeners) {
          listener({ code: 255, signal: null });
        }
      },
    } satisfies SafeConnectMasterHandle & { exit(): void; stopped: boolean };
    handles.push(handle);
    return handle;
  });
  const manager = new SafeConnectSshLeaseManager({
    resolveCurrentTarget,
    createAuthenticatedSession,
    createMultiplexedSession,
    disposeSession,
    startMaster,
    idleTtlMs: 60_000,
    onAuthenticationFailure: options.onAuthenticationFailure,
    ...(options.maxChannels ? { maxChannels: options.maxChannels } : {}),
    ...(options.maxQueuedChannels ? { maxQueuedChannels: options.maxQueuedChannels } : {}),
  });
  return {
    manager,
    resolveCurrentTarget,
    setCurrentTarget: (target: PlatformClawExecutionTargetSnapshot) => {
      currentTarget = target;
    },
    handles,
    createAuthenticatedSession,
    createMultiplexedSession,
    disposeSession,
    startMaster,
  };
}

describe("SafeConnectSshLeaseManager", () => {
  it("admits five persistent ACP channels plus one normal execution channel by default", async () => {
    const harness = createHarness();
    const acp = await Promise.all(
      Array.from({ length: 5 }, () => harness.manager.createSession(TARGET)),
    );
    const normal = await harness.manager.createSession(TARGET);
    expect(harness.createMultiplexedSession).toHaveBeenCalledTimes(6);
    await Promise.all([...acp, normal].map(async (value) => await value.onDispose?.()));
    await harness.manager.dispose();
  });
  it("reuses one authenticated master across sequential sessions", async () => {
    const harness = createHarness();

    const first = await harness.manager.createSession(TARGET);
    await first.onDispose?.();
    const second = await harness.manager.createSession(TARGET);
    await second.onDispose?.();

    expect(harness.startMaster).toHaveBeenCalledTimes(1);
    expect(harness.createAuthenticatedSession).toHaveBeenCalledTimes(1);
    expect(harness.createMultiplexedSession).toHaveBeenCalledTimes(2);
    await harness.manager.dispose();
  });

  it("queues channels above the proven concurrency cap", async () => {
    const harness = createHarness({ maxChannels: 2 });
    const first = await harness.manager.createSession(TARGET);
    const second = await harness.manager.createSession(TARGET);
    let admitted = false;
    const thirdPromise = harness.manager.createSession(TARGET).then((value) => {
      admitted = true;
      return value;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);

    await first.onDispose?.();
    const third = await thirdPromise;
    expect(admitted).toBe(true);
    await Promise.all([second.onDispose?.(), third.onDispose?.()]);
    await harness.manager.dispose();
  });

  it("coalesces concurrent master authentication", async () => {
    const harness = createHarness();
    const sessions = await Promise.all(
      Array.from({ length: 4 }, async () => await harness.manager.createSession(TARGET)),
    );

    expect(harness.startMaster).toHaveBeenCalledOnce();
    await Promise.all(sessions.map(async (value) => await value.onDispose?.()));
    await harness.manager.dispose();
  });

  it("reports a shared authentication rejection once and only retries a new credential revision", async () => {
    let finishReport!: () => void;
    const report = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finishReport = resolve;
        }),
    );
    const harness = createHarness({ onAuthenticationFailure: report });
    const rejection = new PlatformClawVmAuthenticationError();
    harness.startMaster.mockRejectedValueOnce(rejection);
    try {
      const attempts = Promise.allSettled(
        Array.from({ length: 4 }, () => harness.manager.createSession(TARGET)),
      );
      await vi.waitFor(() => expect(report).toHaveBeenCalledExactlyOnceWith(TARGET));
      expect(harness.startMaster).toHaveBeenCalledOnce();
      finishReport();
      expect(await attempts).toEqual(
        Array.from({ length: 4 }, () => ({ status: "rejected", reason: rejection })),
      );
      await expect(harness.manager.createSession(TARGET)).rejects.toBe(rejection);
      expect(harness.startMaster).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledOnce();
      expect(harness.createMultiplexedSession).not.toHaveBeenCalled();

      const revisedTarget = {
        ...TARGET,
        credentialRevision: TARGET.credentialRevision + 1,
      };
      harness.setCurrentTarget(revisedTarget);
      const revised = await harness.manager.createSession(revisedTarget);
      expect(harness.startMaster).toHaveBeenCalledTimes(2);
      await revised.onDispose?.();
    } finally {
      finishReport?.();
      await harness.manager.dispose();
    }
  });

  it("does not record or latch a network failure as rejected credentials", async () => {
    const report = vi.fn(async () => {});
    const harness = createHarness({ onAuthenticationFailure: report });
    harness.startMaster.mockRejectedValueOnce(new Error("Connection refused"));
    try {
      await expect(harness.manager.createSession(TARGET)).rejects.toThrow("Connection refused");
      expect(report).not.toHaveBeenCalled();
      const recovered = await harness.manager.createSession(TARGET);
      expect(harness.startMaster).toHaveBeenCalledTimes(2);
      await recovered.onDispose?.();
    } finally {
      await harness.manager.dispose();
    }
  });

  it("reports an unavailable recovery service without disclosing its diagnostics", async () => {
    const reportFailure = new Error("private recovery diagnostic");
    const report = vi.fn(async () => {
      throw reportFailure;
    });
    const harness = createHarness({ onAuthenticationFailure: report });
    harness.startMaster.mockRejectedValueOnce(new PlatformClawVmAuthenticationError());
    try {
      await expect(harness.manager.createSession(TARGET)).rejects.toMatchObject({
        name: "PlatformClawVmAuthenticationError",
        message:
          "development VM authentication failed; the recovery service is unavailable, open work location settings to reconnect",
        cause: reportFailure,
      });
      await expect(harness.manager.createSession(TARGET)).rejects.toThrow("recovery service");
      expect(report).toHaveBeenCalledOnce();
      expect(harness.startMaster).toHaveBeenCalledOnce();
    } finally {
      await harness.manager.dispose();
    }
  });

  it("removes a canceled queued read so the next command can use the remaining capacity", async () => {
    const harness = createHarness({ maxChannels: 1, maxQueuedChannels: 1 });
    try {
      const active = await harness.manager.createSession(TARGET);
      const controller = new AbortController();
      const canceled = harness.manager.createSession(TARGET, controller.signal);
      const rejection = expect(canceled).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await rejection;
      expect(harness.createMultiplexedSession).toHaveBeenCalledOnce();
      // Queue capacity is one: this would reject if the canceled waiter stayed.
      const next = harness.manager.createSession(TARGET);
      await active.onDispose?.();
      const admitted = await next;
      expect(harness.createMultiplexedSession).toHaveBeenCalledTimes(2);
      await admitted.onDispose?.();
      const future = await harness.manager.createSession(TARGET);
      expect(harness.createMultiplexedSession).toHaveBeenCalledTimes(3);
      await future.onDispose?.();
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await expect(
        harness.manager.createSession(TARGET, alreadyAborted.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(harness.createMultiplexedSession).toHaveBeenCalledTimes(3);
    } finally {
      await harness.manager.dispose();
    }
  });

  it("retires an old master when credential revision changes", async () => {
    const harness = createHarness();
    const first = await harness.manager.createSession(TARGET);
    const revised = { ...TARGET, credentialRevision: TARGET.credentialRevision + 1 };
    harness.setCurrentTarget(revised);

    const second = await harness.manager.createSession(revised);
    expect(harness.startMaster).toHaveBeenCalledTimes(2);
    expect(harness.handles[0]?.stopped).toBe(true);

    await first.onDispose?.();
    await vi.waitFor(() => expect(harness.handles[0]?.stopped).toBe(true));
    await second.onDispose?.();
    await harness.manager.dispose();
  });

  it("disposes a session prepared after cancellation and releases its acquired channel", async () => {
    const harness = createHarness({ maxChannels: 1 });
    const controller = new AbortController();
    const canceledSession = session(999);
    harness.createMultiplexedSession.mockImplementationOnce(async () => {
      controller.abort();
      return canceledSession;
    });
    try {
      await expect(harness.manager.createSession(TARGET, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(harness.disposeSession).toHaveBeenCalledWith(canceledSession);
      const future = await harness.manager.createSession(TARGET);
      await future.onDispose?.();
    } finally {
      await harness.manager.dispose();
    }
  });

  it("rejects old prepared credentials and stale observations without retiring the current lease", async () => {
    const harness = createHarness();
    const revised = { ...TARGET, credentialRevision: TARGET.credentialRevision + 1 };
    harness.setCurrentTarget(revised);
    try {
      const current = await harness.manager.createSession(revised);
      await expect(harness.manager.createSession(TARGET)).rejects.toThrow("authority changed");
      await harness.manager.observeTarget(TARGET.agentId, TARGET);
      await harness.manager.observeTarget(TARGET.agentId, {
        kind: "platform_server",
        agentId: TARGET.agentId,
        targetId: "platform-server",
        revision: TARGET.revision - 1,
      });
      expect(harness.handles[0]?.stopped).toBe(false);
      const reused = await harness.manager.createSession(revised);
      expect(harness.createAuthenticatedSession).toHaveBeenCalledOnce();
      await Promise.all([current.onDispose?.(), reused.onDispose?.()]);
    } finally {
      await harness.manager.dispose();
    }
  });

  it("revalidates an awaited prepared session and preserves a newer master", async () => {
    const harness = createHarness();
    let finishPreparation!: (value: SshSandboxSession) => void;
    harness.createMultiplexedSession.mockImplementationOnce(
      async () =>
        await new Promise<SshSandboxSession>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    try {
      const obsolete = harness.manager.createSession(TARGET);
      const rejected = expect(obsolete).rejects.toThrow("authority changed");
      await vi.waitFor(() => expect(harness.createMultiplexedSession).toHaveBeenCalledOnce());
      const revised = { ...TARGET, credentialRevision: TARGET.credentialRevision + 1 };
      harness.setCurrentTarget(revised);
      const current = await harness.manager.createSession(revised);
      const prepared = session(999);
      finishPreparation(prepared);
      await rejected;
      expect(harness.disposeSession).toHaveBeenCalledWith(prepared);
      expect(harness.handles[1]?.stopped).toBe(false);
      const reused = await harness.manager.createSession(revised);
      expect(harness.startMaster).toHaveBeenCalledTimes(2);
      await Promise.all([current.onDispose?.(), reused.onDispose?.()]);
    } finally {
      finishPreparation?.(session(1000));
      await harness.manager.dispose();
    }
  });

  it("does not replace a newer lease when an older authority lookup completes late", async () => {
    const harness = createHarness();
    let finishLookup!: (value: PlatformClawExecutionTargetSnapshot) => void;
    harness.resolveCurrentTarget.mockImplementationOnce(
      async () =>
        await new Promise<PlatformClawExecutionTargetSnapshot>((resolve) => {
          finishLookup = resolve;
        }),
    );
    try {
      const obsolete = harness.manager.createSession(TARGET);
      const rejected = expect(obsolete).rejects.toThrow("authority changed");
      await vi.waitFor(() => expect(harness.resolveCurrentTarget).toHaveBeenCalledOnce());
      const revised = { ...TARGET, credentialRevision: TARGET.credentialRevision + 1 };
      harness.setCurrentTarget(revised);
      const current = await harness.manager.createSession(revised);
      finishLookup(TARGET);
      await rejected;
      expect(harness.handles[0]?.stopped).toBe(false);
      expect(harness.createAuthenticatedSession).toHaveBeenCalledOnce();
      await current.onDispose?.();
    } finally {
      finishLookup?.(TARGET);
      await harness.manager.dispose();
    }
  });

  it("cannot reopen a revoked target even when its prepared snapshot still has a credential revision", async () => {
    const harness = createHarness();
    try {
      const previous = await harness.manager.createSession(TARGET);
      harness.resolveCurrentTarget.mockRejectedValue(
        new Error("assigned VM execution target is not ready"),
      );
      await expect(harness.manager.createSession(TARGET)).rejects.toThrow("not ready");
      await expect(harness.manager.createSession(TARGET)).rejects.toThrow("not ready");
      expect(harness.handles[0]?.stopped).toBe(true);
      expect(harness.createAuthenticatedSession).toHaveBeenCalledOnce();
      await previous.onDispose?.();
    } finally {
      await harness.manager.dispose();
    }
  });

  it("uses canonical identity rather than comparing credential revisions across saved VM switches", async () => {
    const harness = createHarness();
    try {
      const previous = await harness.manager.createSession(TARGET);
      const selected = {
        ...TARGET,
        revision: TARGET.revision + 1,
        credentialRevision: 1,
        targetId: "allocation-2",
        allocationId: "allocation-2",
        linuxAccount: "other-account",
      };
      harness.setCurrentTarget(selected);
      const current = await harness.manager.createSession(selected);
      expect(harness.handles[0]?.stopped).toBe(true);
      await expect(harness.manager.createSession(TARGET)).rejects.toThrow("authority changed");
      expect(harness.handles[1]?.stopped).toBe(false);
      await Promise.all([previous.onDispose?.(), current.onDispose?.()]);
    } finally {
      await harness.manager.dispose();
    }
  });

  it("reauthenticates once after the master exits", async () => {
    const harness = createHarness();
    const first = await harness.manager.createSession(TARGET);
    await first.onDispose?.();
    harness.handles[0]?.exit();
    await vi.waitFor(() => expect(harness.disposeSession).toHaveBeenCalledTimes(1));

    const second = await harness.manager.createSession(TARGET);
    expect(harness.startMaster).toHaveBeenCalledTimes(2);
    await second.onDispose?.();
    await harness.manager.dispose();
  });

  it("opens a new lease after the idle window expires", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const first = await harness.manager.createSession(TARGET);
      await first.onDispose?.();
      await vi.advanceTimersByTimeAsync(60_000);

      const second = await harness.manager.createSession(TARGET);
      expect(harness.startMaster).toHaveBeenCalledTimes(2);
      await second.onDispose?.();
      await harness.manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancels a previous idle timer while a persistent terminal channel is active", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const first = await harness.manager.createSession(TARGET);
      await first.onDispose?.();
      await vi.advanceTimersByTimeAsync(59_000);
      const terminal = await harness.manager.createSession(TARGET);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(harness.handles[0]?.stopped).toBe(false);
      expect(harness.startMaster).toHaveBeenCalledOnce();
      await terminal.onDispose?.();
      await harness.manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
