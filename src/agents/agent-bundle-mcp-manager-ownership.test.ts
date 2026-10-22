import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";
import {
  DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntimeManager } from "./agent-bundle-mcp-types.js";
import { testing as resolverTesting } from "./mcp-connection-resolver.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function config(
  kind: "static" | "scoped" | "mixed" = "static",
  version = "zero",
  scopedVersion = "one",
): OpenClawConfig {
  return {
    plugins: { enabled: false },
    mcp: {
      servers: {
        ...(kind !== "scoped"
          ? {
              shared: {
                url: `https://static.example.test/${version}`,
                transport: "streamable-http" as const,
              },
            }
          : {}),
        ...(kind !== "static"
          ? {
              personal: {
                url: `https://declared.example.test/${scopedVersion}`,
                transport: "streamable-http" as const,
              },
            }
          : {}),
      },
    },
  };
}

const managers: SessionMcpRuntimeManager[] = [];
function createHarness() {
  let now = 0;
  const createRuntime = vi.fn<CreateSessionMcpRuntime>((params) => ({
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    configFingerprint: params.configFingerprint!,
    requesterScope: params.requesterScope,
    createdAt: now,
    lastUsedAt: now,
    markUsed: () => {},
    getCatalog: async () => ({ version: 1, generatedAt: 0, servers: {}, tools: [] }),
    peekCatalog: () => null,
    callTool: async () => ({ content: [] }),
    dispose: vi.fn(async () => {}),
  }));
  const manager = createSessionMcpRuntimeManager({
    createRuntime,
    now: () => now,
    enableIdleSweepTimer: false,
  });
  managers.push(manager);
  const params = {
    sessionId: "session",
    sessionKey: "session-key",
    workspaceDir: "/workspace",
    manifestRegistry: { plugins: [] },
  };
  return {
    manager,
    createRuntime,
    params,
    run: (cfg = config()) => manager.getOrCreate({ ...params, cfg }),
    expireRuntimes: () => {
      now += DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS + 1;
    },
    advanceTime: (elapsedMs: number) => {
      now += elapsedMs;
    },
  };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  resolverTesting.setMcpServerConnectionResolversForTest(null);
  resolverTesting.setMcpConnectionRevalidateMsForTest();
});

describe("MCP runtime creation ownership", () => {
  it.each([
    { kind: "static", scope: "session" },
    { kind: "static", scope: "all" },
    { kind: "scoped", scope: "session" },
    { kind: "scoped", scope: "all" },
    { kind: "mixed", scope: "session" },
    { kind: "mixed", scope: "all" },
  ] as const)(
    "cancels immediate full $kind creation during $scope disposal",
    async ({ kind, scope }) => {
      resolverTesting.setMcpServerConnectionResolversForTest([
        { serverName: "personal", resolve: async () => null },
      ]);
      const harness = createHarness();
      const pending = harness.run(config(kind));
      const rejected = expect(pending).rejects.toThrow(/superseded/);
      const disposing =
        scope === "session"
          ? harness.manager.disposeSession("session")
          : harness.manager.disposeAll();
      await rejected;
      await disposing;
      expect(harness.createRuntime).not.toHaveBeenCalled();
      expect(harness.manager.listRuntimeKeys()).toEqual([]);
      expect(harness.manager.resolveSessionId("session-key")).toBeUndefined();
    },
  );

  it("deduplicates concurrent creation for the same definition and generation", async () => {
    const harness = createHarness();
    const [first, second] = await Promise.all([harness.run(), harness.run()]);
    expect(second).toBe(first);
    expect(harness.createRuntime).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "lets the newest replacement win while disposal is pending (same static fingerprint: %s)",
    async (sameStaticFingerprint) => {
      resolverTesting.setMcpServerConnectionResolversForTest([
        { serverName: "personal", resolve: async () => null },
      ]);
      const harness = createHarness();
      const kind = sameStaticFingerprint ? "mixed" : "static";
      await harness.run(config(kind));
      const original = harness.manager.peekSession({ sessionId: "session" })!;
      const started = deferred();
      const release = deferred();
      vi.mocked(original.dispose).mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      });
      const older = harness.run(config(kind, "older"));
      const rejected = expect(older).rejects.toThrow(/superseded/);
      let olderSettled = false;
      void older.then(
        () => {
          olderSettled = true;
        },
        () => {
          olderSettled = true;
        },
      );
      await started.promise;
      const newer = harness.run(
        config(
          kind,
          sameStaticFingerprint ? "older" : "newer",
          sameStaticFingerprint ? "two" : "one",
        ),
      );
      // Let the new call claim its key before releasing the captured teardown.
      await nextTurn();
      const settledBeforeRelease = olderSettled;
      const buildsBeforeRelease = harness.createRuntime.mock.calls.length;
      release.resolve();
      await rejected;
      await newer;
      expect(settledBeforeRelease).toBe(false);
      expect(buildsBeforeRelease).toBe(1);
      expect(harness.manager.peekSession({ sessionId: "session" })).toBe(
        harness.createRuntime.mock.results.at(-1)!.value,
      );
      expect(harness.createRuntime).toHaveBeenCalledTimes(2);
      expect(original.dispose).toHaveBeenCalledTimes(1);
      expect(harness.createRuntime.mock.calls.at(-1)![0].cfg?.mcp?.servers?.shared?.url).toBe(
        `https://static.example.test/${sameStaticFingerprint ? "older" : "newer"}`,
      );
    },
  );

  it.each(["session", "all"] as const)(
    "preserves fresh runtime and session mapping during an old %s drain",
    async (scope) => {
      const harness = createHarness();
      const original = await harness.run();
      const started = deferred();
      const release = deferred();
      vi.mocked(original.dispose).mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      });
      const older = harness.run(config("static", "older"));
      const rejected = expect(older).rejects.toThrow(/superseded/);
      await started.promise;
      const disposing =
        scope === "session"
          ? harness.manager.disposeSession("session")
          : harness.manager.disposeAll();
      const current = await harness.run(config("static", "newer"));
      expect(harness.manager.peekSession({ sessionId: "session" })).toBe(current);
      release.resolve();
      await rejected;
      await disposing;
      expect(harness.manager.peekSession({ sessionId: "session" })).toBe(current);
      expect(current.dispose).not.toHaveBeenCalled();
      expect(original.dispose).toHaveBeenCalledTimes(1);
      expect(harness.manager.resolveSessionId("session-key")).toBe("session");
    },
  );

  it("rejects an obsolete declaration after the initial idle sweep awaits disposal", async () => {
    const harness = createHarness();
    const original = await harness.run();
    const started = deferred();
    const release = deferred();
    vi.mocked(original.dispose).mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
    });
    harness.expireRuntimes();
    const older = harness.run(config("static", "older"));
    const rejected = expect(older).rejects.toThrow(/superseded/);
    await started.promise;
    const current = await harness.run(config("static", "newer"));
    release.resolve();
    await rejected;
    expect(harness.manager.peekSession({ sessionId: "session" })).toBe(current);
    expect(current.dispose).not.toHaveBeenCalled();
    expect(harness.createRuntime).toHaveBeenCalledTimes(2);
  });

  it("preserves a new requester's session mapping while an old resolver drains", async () => {
    const started = deferred();
    const release = deferred();
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "personal",
        resolve: async ({ requesterSenderId }) => {
          if (requesterSenderId === "alice") {
            started.resolve();
            await release.promise;
          }
          return { url: `https://resolved.example.test/${requesterSenderId}` };
        },
      },
    ]);
    const harness = createHarness();
    const params = { ...harness.params, cfg: config("scoped") };
    const older = harness.manager.getOrCreateRequesterScoped({
      ...params,
      requesterSenderId: "alice",
    });
    await started.promise;
    const disposing = harness.manager.disposeSession("session");
    const current = await harness.manager.getOrCreateRequesterScoped({
      ...params,
      requesterSenderId: "bob",
    });
    release.resolve();
    await expect(older).resolves.toBeUndefined();
    await disposing;
    expect(current).toBeDefined();
    expect(current!.dispose).not.toHaveBeenCalled();
    expect(harness.manager.resolveSessionId("session-key")).toBe("session");
  });

  it("propagates teardown errors from the owning replacement", async () => {
    const harness = createHarness();
    const original = await harness.run();
    vi.mocked(original.dispose).mockRejectedValueOnce(new Error("teardown failed"));
    await expect(harness.run(config("static", "newer"))).rejects.toThrow("teardown failed");
    expect(harness.createRuntime).toHaveBeenCalledTimes(1);
    expect(harness.manager.listRuntimeKeys()).toEqual([]);
  });

  it.each([
    { scope: "session", generations: "AB" },
    { scope: "all", generations: "AB" },
    { scope: "session", generations: "ABC" },
    { scope: "all", generations: "ABC" },
  ] as const)(
    "waits for detached scoped retirement during $scope disposal after $generations",
    async ({ scope, generations }) => {
      resolverTesting.setMcpServerConnectionResolversForTest([
        {
          serverName: "personal",
          resolve: async () => ({ url: "https://resolved.example.test/alice" }),
        },
      ]);
      const harness = createHarness();
      const original = (await harness.manager.getOrCreateRequesterScoped({
        ...harness.params,
        cfg: config("scoped"),
        requesterSenderId: "alice",
      }))!;
      const started = deferred();
      const release = deferred();
      vi.mocked(original.dispose).mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      });
      const changes = [
        harness.manager.getOrCreateRequesterScoped({
          ...harness.params,
          cfg: config("scoped", "zero", "two"),
        }),
      ];
      await started.promise;
      if (generations === "ABC") {
        changes.push(
          harness.manager.getOrCreateRequesterScoped({
            ...harness.params,
            cfg: config("scoped", "zero", "three"),
          }),
        );
      }
      let finished = false;
      const disposing =
        scope === "session"
          ? harness.manager.disposeSession("session")
          : harness.manager.disposeAll();
      void disposing.then(() => {
        finished = true;
      });
      await nextTurn();
      const finishedBeforeRelease = finished;
      release.resolve();
      await Promise.all([...changes, disposing]);
      expect(finishedBeforeRelease).toBe(false);
      expect(finished).toBe(true);
      expect(original.dispose).toHaveBeenCalledTimes(1);
      expect(harness.createRuntime).toHaveBeenCalledTimes(1);
      expect(harness.manager.listRuntimeKeys()).toEqual([]);
      expect(harness.manager.getAdvertisedScopedCatalog("session")).toBeNull();
    },
  );

  it.each([
    { scope: "session", changeConfig: false },
    { scope: "agent", changeConfig: true },
    { scope: "agent", changeConfig: false },
  ] as const)(
    "retains captured cleanup ownership during blocked revalidation and $scope disposal (config changed: $changeConfig)",
    async ({ scope, changeConfig }) => {
      resolverTesting.setMcpConnectionRevalidateMsForTest(1);
      const resolveStarted = deferred();
      const releaseResolve = deferred();
      let aliceResolutions = 0;
      resolverTesting.setMcpServerConnectionResolversForTest([
        {
          serverName: "personal",
          resolve: async ({ requesterSenderId }) => {
            if (requesterSenderId === "alice" && ++aliceResolutions === 2) {
              resolveStarted.resolve();
              await releaseResolve.promise;
            }
            return { url: `https://resolved.example.test/${requesterSenderId}` };
          },
        },
      ]);
      const harness = createHarness();
      const aliceParams = {
        ...harness.params,
        cfg: config("scoped"),
        requesterSenderId: "alice",
        agentId: "alice",
      };
      const original = (await harness.manager.getOrCreateRequesterScoped(aliceParams))!;
      const disposeStarted = deferred();
      const releaseDispose = deferred();
      vi.mocked(original.dispose).mockImplementationOnce(async () => {
        disposeStarted.resolve();
        await releaseDispose.promise;
      });
      harness.advanceTime(2);
      const revalidating = harness.manager.getOrCreateRequesterScoped(aliceParams);
      await resolveStarted.promise;
      let finished = false;
      const disposing =
        scope === "session"
          ? harness.manager.disposeSession("session")
          : harness.manager.disposeAgentScoped("alice");
      void disposing.then(() => {
        finished = true;
      });
      const fresh = harness.manager.getOrCreateRequesterScoped({
        ...harness.params,
        cfg: changeConfig ? config("scoped", "zero", "two") : aliceParams.cfg,
        requesterSenderId: "bob",
        agentId: "bob",
      });
      await disposeStarted.promise;
      releaseResolve.resolve();
      await nextTurn();
      const finishedBeforeRelease = finished;
      releaseDispose.resolve();
      const [retired, current] = await Promise.all([revalidating, fresh, disposing]);
      expect(finishedBeforeRelease).toBe(false);
      expect(finished).toBe(true);
      expect(retired).toBeUndefined();
      expect(current).toBeDefined();
      expect(current!.requesterScope?.agentId).toBe("bob");
      expect(current!.dispose).not.toHaveBeenCalled();
      expect(original.dispose).toHaveBeenCalledTimes(1);
      const expectedAliceRuntimes = scope === "agent" && !changeConfig ? 2 : 1;
      const aliceRuntimes = harness.createRuntime.mock.results
        .filter((result) => result.type === "return")
        .map((result) => result.value)
        .filter((runtime) => runtime.requesterScope?.agentId === "alice");
      expect(aliceRuntimes).toHaveLength(expectedAliceRuntimes);
      for (const runtime of aliceRuntimes) {
        expect(runtime.dispose).toHaveBeenCalledTimes(1);
      }
      expect(harness.createRuntime).toHaveBeenCalledTimes(expectedAliceRuntimes + 1);
      expect(harness.manager.listRuntimeKeys()).toHaveLength(1);
      expect(harness.manager.resolveSessionId("session-key")).toBe("session");
    },
  );

  it.each(["AB", "ABC"] as const)(
    "finds an agent's already-detached retirement after %s replacement",
    async (generations) => {
      resolverTesting.setMcpServerConnectionResolversForTest([
        {
          serverName: "personal",
          resolve: async ({ requesterSenderId }) => ({
            url: `https://resolved.example.test/${requesterSenderId}`,
          }),
        },
      ]);
      const harness = createHarness();
      const original = (await harness.manager.getOrCreateRequesterScoped({
        ...harness.params,
        cfg: config("scoped"),
        requesterSenderId: "alice",
        agentId: "alice",
      }))!;
      const started = deferred();
      const release = deferred();
      vi.mocked(original.dispose).mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      });
      const bobParams = {
        ...harness.params,
        requesterSenderId: "bob",
        agentId: "bob",
      };
      const replacements = [
        harness.manager.getOrCreateRequesterScoped({
          ...bobParams,
          cfg: config("scoped", "zero", "two"),
        }),
      ];
      await started.promise;
      if (generations === "ABC") {
        replacements.push(
          harness.manager.getOrCreateRequesterScoped({
            ...bobParams,
            cfg: config("scoped", "zero", "three"),
          }),
        );
      }
      let finished = false;
      const disposing = harness.manager.disposeAgentScoped("alice");
      void disposing.then(() => {
        finished = true;
      });
      let finishedBeforeRelease = false;
      try {
        await nextTurn();
        finishedBeforeRelease = finished;
      } finally {
        release.resolve();
      }
      const disposed = await disposing;
      const results = await Promise.all(replacements);
      const current = results.at(-1);
      expect(finishedBeforeRelease).toBe(false);
      expect(disposed).toBe(1);
      expect(original.dispose).toHaveBeenCalledTimes(1);
      expect(current).toBeDefined();
      expect(current!.requesterScope?.agentId).toBe("bob");
      expect(current!.dispose).not.toHaveBeenCalled();
      expect(harness.createRuntime).toHaveBeenCalledTimes(2);
      expect(harness.manager.listRuntimeKeys()).toHaveLength(1);
      expect(harness.manager.resolveSessionId("session-key")).toBe("session");
    },
  );

  it("keeps bare runtime cleanup visible when disposeAll follows disposeSession", async () => {
    const harness = createHarness();
    const original = await harness.run();
    const started = deferred();
    const release = deferred();
    vi.mocked(original.dispose).mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
    });
    const sessionDisposal = harness.manager.disposeSession("session");
    await started.promise;
    let finished = false;
    const allDisposal = harness.manager.disposeAll();
    void allDisposal.then(() => {
      finished = true;
    });
    let finishedBeforeRelease = false;
    try {
      await nextTurn();
      finishedBeforeRelease = finished;
    } finally {
      release.resolve();
    }
    await Promise.all([sessionDisposal, allDisposal]);
    expect(finishedBeforeRelease).toBe(false);
    expect(finished).toBe(true);
    expect(original.dispose).toHaveBeenCalledTimes(1);
    expect(harness.createRuntime).toHaveBeenCalledTimes(1);
    expect(harness.manager.listRuntimeKeys()).toEqual([]);
    expect(harness.manager.resolveSessionId("session-key")).toBeUndefined();
  });

  it.each(["agent", "session"] as const)(
    "starts teardown eagerly and retains it for %s disposal after disposeAll",
    async (scope) => {
      resolverTesting.setMcpConnectionRevalidateMsForTest(1);
      const resolveStarted = deferred();
      const releaseResolve = deferred();
      let resolutions = 0;
      resolverTesting.setMcpServerConnectionResolversForTest([
        {
          serverName: "personal",
          resolve: async () => {
            if (++resolutions === 2) {
              resolveStarted.resolve();
              await releaseResolve.promise;
            }
            return { url: "https://resolved.example.test/alice" };
          },
        },
      ]);
      const harness = createHarness();
      const params = {
        ...harness.params,
        cfg: config("scoped"),
        requesterSenderId: "alice",
        agentId: "alice",
      };
      const original = (await harness.manager.getOrCreateRequesterScoped(params))!;
      const releaseDispose = deferred();
      let closeStarted = false;
      vi.mocked(original.dispose).mockImplementationOnce(async () => {
        closeStarted = true;
        await releaseDispose.promise;
      });
      harness.advanceTime(2);
      const revalidating = harness.manager.getOrCreateRequesterScoped(params);
      await resolveStarted.promise;
      const allDisposal = harness.manager.disposeAll();
      let targetedFinished = false;
      let eagerClose = false;
      let targetedFinishedBeforeRelease = false;
      let targetedDisposal: Promise<void | number> = Promise.resolve();
      try {
        await nextTurn();
        eagerClose = closeStarted;
        targetedDisposal =
          scope === "agent"
            ? harness.manager.disposeAgentScoped("alice")
            : harness.manager.disposeSession("session");
        void targetedDisposal.then(() => {
          targetedFinished = true;
        });
        releaseResolve.resolve();
        await nextTurn();
        targetedFinishedBeforeRelease = targetedFinished;
      } finally {
        releaseResolve.resolve();
        releaseDispose.resolve();
      }
      const [retired, , count] = await Promise.all([revalidating, allDisposal, targetedDisposal]);
      expect(eagerClose).toBe(true);
      expect(targetedFinishedBeforeRelease).toBe(false);
      expect(retired).toBeUndefined();
      if (scope === "agent") {
        expect(count).toBe(1);
      }
      expect(original.dispose).toHaveBeenCalledTimes(1);
      expect(harness.createRuntime).toHaveBeenCalledTimes(1);
      expect(harness.manager.listRuntimeKeys()).toEqual([]);
      expect(harness.manager.resolveSessionId("session-key")).toBeUndefined();
    },
  );

  it.each(["agent", "session", "all"] as const)(
    "retains an idle sweep's pending teardown for %s disposal",
    async (scope) => {
      resolverTesting.setMcpServerConnectionResolversForTest([
        {
          serverName: "personal",
          resolve: async () => ({ url: "https://resolved.example.test/alice" }),
        },
      ]);
      const harness = createHarness();
      const original = (await harness.manager.getOrCreateRequesterScoped({
        ...harness.params,
        cfg: config("scoped"),
        requesterSenderId: "alice",
        agentId: "alice",
      }))!;
      const started = deferred();
      const release = deferred();
      vi.mocked(original.dispose).mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      });
      harness.expireRuntimes();
      const sweeping = harness.manager.sweepIdleRuntimes();
      await started.promise;
      let finished = false;
      const disposing =
        scope === "agent"
          ? harness.manager.disposeAgentScoped("alice")
          : scope === "session"
            ? harness.manager.disposeSession("session")
            : harness.manager.disposeAll();
      void disposing.then(() => {
        finished = true;
      });
      let finishedBeforeRelease = false;
      try {
        await nextTurn();
        finishedBeforeRelease = finished;
      } finally {
        release.resolve();
      }
      const [swept, count] = await Promise.all([sweeping, disposing]);
      expect(finishedBeforeRelease).toBe(false);
      expect(swept).toBe(1);
      if (scope === "agent") {
        expect(count).toBe(1);
      }
      expect(original.dispose).toHaveBeenCalledTimes(1);
      expect(harness.createRuntime).toHaveBeenCalledTimes(1);
      expect(harness.manager.listRuntimeKeys()).toEqual([]);
      expect(harness.manager.resolveSessionId("session-key")).toBeUndefined();
    },
  );
});
