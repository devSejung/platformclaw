import { EventEmitter } from "node:events";
import {
  diagnoseAcpProcessTransport,
  launchWithAcpProcessTransport,
  prepareAcpProcessTransport,
  releaseAcpProcessTransport,
  type AcpProcessTransportLaunch,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { launchAssignedVmAcpProcess } from "./src/acp-process-transport.js";
import type { AssignedVmTargetSnapshot } from "./src/backend.js";

const { createRuntime, runSshCommand, disposeSshSession, spawn } = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  runSshCommand: vi.fn(),
  disposeSshSession: vi.fn(async () => undefined),
  spawn: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));
vi.mock("openclaw/plugin-sdk/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/sandbox")>()),
  runSshSandboxCommand: runSshCommand,
  disposeSshSandboxSession: disposeSshSession,
}));
vi.mock("./src/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/runtime.js")>()),
  createExecutionDependenciesFromEnvironment: createRuntime,
}));

type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
const route = {
  executionOwnerAgentId: "person_one",
  agent: "codex",
  sessionKey: "agent:person_one:acp:one",
};
const target: AssignedVmTargetSnapshot = {
  kind: "assigned_vm",
  agentId: route.executionOwnerAgentId,
  targetId: "vm-one",
  revision: 1,
  allocationId: "allocation-one",
  credentialRevision: 1,
  vmLabel: "Development VM",
  safeConnectLabel: "Test access",
  remoteHomeDir: "/home/person",
  remoteWorkspaceDir: "/workspace",
  endpointHost: "safeconnect.example",
  endpointPort: 44422,
  adDomain: "example.com",
  adAccount: "person.one",
  targetAddress: "192.0.2.10",
  linuxAccount: "person",
  hostKeyAlgorithm: "ssh-ed25519",
  hostKeyPublicKey: "AAAA-test-key",
  hostKeyFingerprint: "SHA256:test",
  codingAgents: [
    { agent: "codex", enabled: true, executablePath: "/home/person/.local/bin/codex" },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

function childProcess() {
  const child = new EventEmitter();
  return Object.assign(child, {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      child.emit("close");
      return true;
    }),
  });
}

function registerRuntime() {
  const resolveTarget = vi.fn(async () => target);
  const launchAcpProcess = vi.fn<
    (
      input: AcpProcessTransportLaunch,
      target: Readonly<AssignedVmTargetSnapshot>,
      signal?: AbortSignal,
    ) => Promise<unknown>
  >(async () => childProcess());
  const diagnoseAcpProcess = vi.fn(
    async (_agent: string, _target: unknown, _signal?: AbortSignal) => ({
      ok: true,
      stage: "ready",
      code: "ready",
      message: "ready",
    }),
  );
  createRuntime.mockResolvedValue({
    resolveTarget,
    launchAcpProcess,
    diagnoseAcpProcess,
    dispose: vi.fn(async () => undefined),
  });
  const methods = new Map<string, GatewayHandler>();
  const stops: Array<() => Promise<void>> = [];
  const registerGatewayMethod = vi.fn((name: string, handler: GatewayHandler) => {
    methods.set(name, handler);
  });
  // Only the external plugin host is a fixture; registration, the transport
  // registry, and the owner's invalidation handler execute unchanged.
  plugin.register({
    registrationMode: "full",
    registerTool: vi.fn(),
    logger: { info: vi.fn() },
    registerGatewayMethod,
    on: vi.fn((event: string, handler: () => Promise<void>) => {
      if (event === "gateway_stop") {
        stops.push(handler);
      }
    }),
  } as unknown as OpenClawPluginApi);
  const stop = async () => {
    await Promise.all(stops.map(async (handler) => await handler()));
  };
  const invalidate = async (agentId = route.executionOwnerAgentId) => {
    const handler = methods.get("platformclaw-execution.invalidateAgent");
    if (!handler) {
      throw new Error("missing registered Agent invalidation method");
    }
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "platformclaw-execution.invalidateAgent",
      handler,
      { scope: "operator.admin" },
    );
    const respond = vi.fn();
    await handler({
      req: {
        type: "req",
        id: "invalidate-agent",
        method: "platformclaw-execution.invalidateAgent",
      },
      params: { agentId },
      client: null,
      isWebchatConnect: () => false,
      respond,
      // The SDK host supplies a complete request; this callback owns only its
      // Agent lifetime and must not derive authority from unrelated chat state.
      get context(): never {
        throw new Error("Agent invalidation must not access Gateway execution context");
      },
    });
    expect(respond).toHaveBeenCalledWith(true, { invalidated: true });
  };
  return { resolveTarget, launchAcpProcess, diagnoseAcpProcess, invalidate, stop };
}

const launch = (selectedRoute = route) =>
  launchWithAcpProcessTransport(
    { agentCommand: "codex", command: "adapter", args: [], cwd: "/workspace", env: {} },
    selectedRoute,
  );

describe("assigned ACP Agent authority invalidation", () => {
  let harness: ReturnType<typeof registerRuntime>;
  beforeEach(() => {
    runSshCommand.mockReset();
    disposeSshSession.mockClear();
    spawn.mockReset();
    vi.stubEnv("PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS", "/run/platformclaw/test.sock");
    vi.stubEnv("PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE", "/run/platformclaw/test-token");
    harness = registerRuntime();
  });
  afterEach(async () => {
    await harness.stop();
    vi.unstubAllEnvs();
  });

  it.each(["invalidate", "stop"])(
    "%s prevents an awaited preparation from reviving its old admission",
    async (action) => {
      const lookup = deferred<typeof target>();
      harness.resolveTarget.mockImplementationOnce(async () => await lookup.promise);
      const preparation = prepareAcpProcessTransport(route);
      const rejected = expect(preparation).rejects.toMatchObject({ code: "target_changed" });
      await vi.waitFor(() => expect(harness.resolveTarget).toHaveBeenCalledOnce());
      await (action === "stop" ? harness.stop() : harness.invalidate());
      lookup.resolve(target);
      await rejected;
      await expect(launch()).rejects.toThrow("No isolated ACP process transport");
      expect(harness.launchAcpProcess).not.toHaveBeenCalled();
    },
  );

  it("rejects invalidation during the launch target lookup before entering SSH", async () => {
    await prepareAcpProcessTransport(route);
    const lookup = deferred<typeof target>();
    harness.resolveTarget.mockImplementationOnce(async () => await lookup.promise);
    const launched = launch();
    const rejected = expect(launched).rejects.toMatchObject({ code: "target_changed" });
    await vi.waitFor(() => expect(harness.resolveTarget).toHaveBeenCalledTimes(2));
    await harness.invalidate();
    lookup.resolve(target);
    await rejected;
    expect(harness.launchAcpProcess).not.toHaveBeenCalled();
  });

  it("preserves a replacement preparation when an old lookup completes", async () => {
    await prepareAcpProcessTransport(route);
    const lookup = deferred<typeof target>();
    harness.resolveTarget.mockImplementationOnce(async () => await lookup.promise);
    const launched = launch();
    const rejected = expect(launched).rejects.toMatchObject({ code: "target_changed" });
    await vi.waitFor(() => expect(harness.resolveTarget).toHaveBeenCalledTimes(2));
    await releaseAcpProcessTransport(route);
    // The broker may reuse the same immutable snapshot object. A new
    // preparation still has its own admission identity.
    await prepareAcpProcessTransport(route);
    lookup.resolve(target);
    await rejected;
    expect(harness.launchAcpProcess).not.toHaveBeenCalled();
    await expect(launch()).resolves.toBeDefined();
  });

  it.each(["invalidate", "release", "stop"])(
    "%s rejects and kills a late child instead of publishing it",
    async (action) => {
      await prepareAcpProcessTransport(route);
      const launchResult = deferred<ReturnType<typeof childProcess>>();
      harness.launchAcpProcess.mockImplementationOnce(async () => await launchResult.promise);
      const launched = launch();
      const rejected = expect(launched).rejects.toMatchObject({ code: "target_changed" });
      await vi.waitFor(() => expect(harness.launchAcpProcess).toHaveBeenCalledOnce());
      const signal = harness.launchAcpProcess.mock.calls[0]?.[2];
      expect(signal).toBeInstanceOf(AbortSignal);
      if (action === "release") {
        await releaseAcpProcessTransport(route);
      } else if (action === "stop") {
        await harness.stop();
      } else {
        await harness.invalidate();
      }
      expect(signal?.aborted).toBe(true);
      const child = childProcess();
      launchResult.resolve(child);
      await rejected;
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      const killCount = child.kill.mock.calls.length;
      await harness.invalidate();
      expect(child.kill).toHaveBeenCalledTimes(killCount);
      if (action !== "stop") {
        await prepareAcpProcessTransport(route);
        await expect(launch()).resolves.toBeDefined();
      }
    },
  );

  it.each(["session", "preflight"])(
    "release stops the real SSH %s boundary before a remote adapter can start",
    async (stage) => {
      await prepareAcpProcessTransport(route);
      const gate = deferred<void>();
      const session = { command: "ssh", configPath: "/tmp/test/config", host: "assigned-vm" };
      const createSession = vi.fn(async () => {
        if (stage === "session") {
          await gate.promise;
        }
        return session;
      });
      runSshCommand.mockImplementationOnce(async () => {
        if (stage === "preflight") {
          await gate.promise;
        }
      });
      harness.launchAcpProcess.mockImplementationOnce(
        async (input, selectedTarget, signal) =>
          await launchAssignedVmAcpProcess({
            input,
            target: selectedTarget,
            signal,
            createSession,
          }),
      );
      const launched = launch();
      const rejected = expect(launched).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() =>
        expect(stage === "session" ? createSession : runSshCommand).toHaveBeenCalledOnce(),
      );
      await releaseAcpProcessTransport(route);
      expect(harness.launchAcpProcess.mock.calls[0]?.[2]?.aborted).toBe(true);
      gate.resolve();
      await rejected;
      expect(spawn).not.toHaveBeenCalled();
      expect(disposeSshSession).toHaveBeenCalledExactlyOnceWith(session);
      if (stage === "session") {
        expect(runSshCommand).not.toHaveBeenCalled();
      } else {
        expect(runSshCommand.mock.calls[0]?.[0].signal.aborted).toBe(true);
      }
    },
  );

  it("keeps an idempotent preparation in the same pending launch lifetime", async () => {
    await prepareAcpProcessTransport(route);
    const result = deferred<ReturnType<typeof childProcess>>();
    harness.launchAcpProcess.mockImplementationOnce(async () => await result.promise);
    const launched = launch();
    await vi.waitFor(() => expect(harness.launchAcpProcess).toHaveBeenCalledOnce());
    const signal = harness.launchAcpProcess.mock.calls[0]?.[2];
    await prepareAcpProcessTransport(route);
    expect(signal?.aborted).toBe(false);
    const child = childProcess();
    result.resolve(child);
    await expect(launched).resolves.toBe(child);
    expect(child.kill).not.toHaveBeenCalled();
    await releaseAcpProcessTransport(route);
    expect(signal?.aborted).toBe(true);
  });

  it("does not revive a released preparation or cancel its replacement and sibling", async () => {
    await prepareAcpProcessTransport(route);
    const lookup = deferred<AssignedVmTargetSnapshot>();
    harness.resolveTarget.mockImplementationOnce(async () => await lookup.promise);
    const preparing = prepareAcpProcessTransport(route);
    const rejected = expect(preparing).rejects.toMatchObject({ code: "target_changed" });
    await vi.waitFor(() => expect(harness.resolveTarget).toHaveBeenCalledTimes(2));
    await releaseAcpProcessTransport(route);
    const sibling = { ...route, sessionKey: "agent:person_one:acp:sibling" };
    await prepareAcpProcessTransport(route);
    await prepareAcpProcessTransport(sibling);
    lookup.resolve(target);
    await rejected;
    await expect(launch()).resolves.toBeDefined();
    await expect(launch(sibling)).resolves.toBeDefined();
    const replacementSignal = harness.launchAcpProcess.mock.calls[0]?.[2];
    const siblingSignal = harness.launchAcpProcess.mock.calls[1]?.[2];
    expect(replacementSignal?.aborted).toBe(false);
    await releaseAcpProcessTransport(route);
    expect(replacementSignal?.aborted).toBe(true);
    expect(siblingSignal?.aborted).toBe(false);
  });

  it("retains capacity for released launches until their unknown results settle", async () => {
    const routes = Array.from({ length: 5 }, (_, index) => ({
      ...route,
      sessionKey: `agent:person_one:acp:pending-${index}`,
    }));
    const gate = deferred<void>();
    const children: Array<ReturnType<typeof childProcess>> = [];
    harness.launchAcpProcess.mockImplementation(async () => {
      await gate.promise;
      const child = childProcess();
      children.push(child);
      return child;
    });
    await Promise.all(routes.map(async (selected) => await prepareAcpProcessTransport(selected)));
    const results = Promise.allSettled(routes.map((selected) => launch(selected)));
    await vi.waitFor(() => expect(harness.launchAcpProcess).toHaveBeenCalledTimes(5));
    await Promise.all(routes.map(async (selected) => await releaseAcpProcessTransport(selected)));
    const next = { ...route, sessionKey: "agent:person_one:acp:next" };
    await prepareAcpProcessTransport(next);
    await expect(launch(next)).rejects.toMatchObject({ code: "session_limit_reached" });
    gate.resolve();
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(children).toHaveLength(5);
    for (const child of children) {
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    }
    await expect(launch(next)).resolves.toBeDefined();
  });

  it("does not let an old child close remove a new lifetime's active process", async () => {
    await prepareAcpProcessTransport(route);
    const first = childProcess();
    // Delay close delivery until after the replacement lifetime has started.
    first.kill.mockImplementation(() => true);
    harness.launchAcpProcess.mockResolvedValueOnce(first);
    await launch();
    await harness.invalidate();
    await prepareAcpProcessTransport(route);
    const second = childProcess();
    harness.launchAcpProcess.mockResolvedValueOnce(second);
    await launch();
    first.emit("close");
    await harness.invalidate();
    expect(second.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });

  it("leaves another Agent's preparation valid", async () => {
    await prepareAcpProcessTransport(route);
    await harness.invalidate("person_two");
    await expect(launch()).resolves.toBeDefined();
  });

  it("aborts a pending diagnostic and never returns stale success", async () => {
    const probe = deferred<Awaited<ReturnType<typeof harness.diagnoseAcpProcess>>>();
    harness.diagnoseAcpProcess.mockImplementationOnce(async () => await probe.promise);
    const report = diagnoseAcpProcessTransport(route);
    await vi.waitFor(() => expect(harness.diagnoseAcpProcess).toHaveBeenCalledOnce());
    const signal = harness.diagnoseAcpProcess.mock.calls[0]?.[2];
    await harness.invalidate();
    expect(signal?.aborted).toBe(true);
    probe.resolve({ ok: true, stage: "ready", code: "ready", message: "ready" });
    await expect(report).resolves.toMatchObject({ ok: false, code: "target_changed" });
  });
});
