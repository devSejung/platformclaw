import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
/** Connected manager lifecycle proof; only external ACP execution and session storage are fake. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAcpProcessTransport } from "../runtime/process-transport.js";
import { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createDeferred,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";
import { DEFAULT_ACP_RUNTIME_IDLE_TTL_MS } from "./manager.utils.js";
import { SessionActorQueue } from "./session-actor-queue.js";

describe("ACP idle and owner capacity", () => {
  installAcpSessionManagerTestLifecycle();
  const managers: InstanceType<typeof AcpSessionManager>[] = [];
  const unregister: Array<() => void> = [];
  afterEach(() => {
    managers.splice(0).forEach((manager) => manager.stopIdleMaintenance());
    unregister.splice(0).forEach((remove) => remove());
    vi.useRealTimers();
  });

  function fixture() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
    unregister.push(
      registerAcpProcessTransport({
        id: "capacity-proof",
        isolatesSandboxedRequesters: true,
        maxConcurrentSessions: 5,
        supports: ({ executionOwnerAgentId }) => executionOwnerAgentId === "person_one",
        prepare: async () => ({ cwd: "/workspace" }),
        launch: async () => {
          throw new Error("external process unused by fake ACP backend");
        },
      }),
    );
    const state = createRuntime();
    const rows = new Map<string, SessionAcpMeta>();
    const memory = new Map<string, string>();
    state.ensureSession.mockImplementation(async (input) => {
      const id = input.resumeSessionId ?? `remembered:${input.sessionKey}`;
      if (input.resumeSessionId && !memory.has(id)) {
        throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "backend resume target unavailable");
      }
      if (!input.resumeSessionId) {
        memory.set(id, "");
      }
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: input.sessionKey,
        backendSessionId: id,
      };
    });
    state.runTurn.mockImplementation(async function* (input) {
      const id = input.handle.backendSessionId!;
      if (input.text.startsWith("remember:")) {
        memory.set(id, input.text.slice(9));
      }
      yield { type: "text_delta", text: memory.get(id) ?? "" };
      yield { type: "done" };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: state.runtime });
    hoisted.readAcpSessionEntryMock.mockImplementation(({ sessionKey }: { sessionKey: string }) => {
      const acp = rows.get(sessionKey);
      return acp
        ? {
            sessionKey,
            storeSessionKey: sessionKey,
            acp,
            entry: { sessionId: sessionKey, updatedAt: Date.now(), acp },
          }
        : null;
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(
      async ({
        sessionKey,
        mutate,
      }: {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { sessionId: string; updatedAt: number; acp?: SessionAcpMeta },
        ) => SessionAcpMeta | null;
      }) => {
        const entry = { sessionId: sessionKey, updatedAt: Date.now(), acp: rows.get(sessionKey) };
        const acp = mutate(entry.acp, entry);
        if (acp) {
          rows.set(sessionKey, acp);
        }
        return { ...entry, acp };
      },
    );
    const manager = new AcpSessionManager();
    managers.push(manager);
    const spawn = async (name: string, owner = "person_one", agent = "codex") => {
      const sessionKey = `agent:${owner}:acp:${name}`;
      await manager.initializeSession({
        cfg: baseCfg,
        sessionKey,
        agent,
        executionOwnerAgentId: owner,
        mode: "persistent",
      });
      return sessionKey;
    };
    const send = (
      sessionKey: string,
      text: string,
      onEvent?: (event: AcpRuntimeEvent) => Promise<void>,
    ) =>
      manager.runTurn({
        cfg: baseCfg,
        sessionKey,
        text,
        mode: "prompt",
        requestId: `${sessionKey}:${text}`,
        provenance: "system",
        onEvent,
      });
    return { manager, state, rows, memory, spawn, send };
  }

  it("periodically releases idle runtime, retains rows, and resumes remembered state on the exact key", async () => {
    const f = fixture();
    const key = await f.spawn("remember");
    await f.send(key, "remember:APPLE");
    const identity = f.rows.get(key)?.identity;
    await vi.advanceTimersByTimeAsync(DEFAULT_ACP_RUNTIME_IDLE_TTL_MS);
    expect(f.state.close).toHaveBeenCalledWith(expect.objectContaining({ reason: "idle-evicted" }));
    expect(f.state.close.mock.calls[0]?.[0].discardPersistentState).toBeUndefined();
    expect(f.rows.get(key)?.identity).toEqual(identity);
    expect(f.rows.get(key)?.state).not.toBe("closed");
    const output: string[] = [];
    await f.send(key, "recall", async (event) => {
      if ("text" in event && event.text) {
        output.push(event.text);
      }
    });
    expect(output).toContain("APPLE");
    expect(f.state.ensureSession.mock.calls[1]?.[0]).toMatchObject({
      sessionKey: key,
      resumeSessionId: `remembered:${key}`,
    });
  });

  it("reclaims owner-scoped LRU idle capacity across harnesses before accepting another spawn", async () => {
    const f = fixture();
    const keys = [];
    for (let i = 0; i < 5; i++) {
      keys.push(await f.spawn(`${i}`, "person_one", i % 2 ? "claude" : "codex"));
      await vi.advanceTimersByTimeAsync(1);
    }
    await f.send(keys[0]!, "touch");
    await f.spawn("sixth");
    expect(f.state.close).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: expect.objectContaining({ sessionKey: keys[1] }),
        reason: "capacity-reclaimed",
      }),
    );
    expect(f.rows.size).toBe(6);
    expect(f.manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(5);
  });

  it("protects five active/approval-waiting turns, rejects sixth, and starts idle time after completion", async () => {
    const f = fixture();
    const gate = createDeferred();
    const entered = createDeferred();
    let started = 0;
    f.state.runTurn.mockImplementation(async function* () {
      if (++started === 5) {
        entered.resolve();
      }
      await gate.promise;
      yield { type: "done" };
    });
    const turns = [];
    for (let i = 0; i < 5; i++) {
      turns.push(f.send(await f.spawn(`${i}`), "wait approval"));
    }
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await expect(f.spawn("sixth")).rejects.toThrow("capacity reached (5)");
    expect(f.state.close).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all(turns);
    await vi.advanceTimersByTimeAsync(DEFAULT_ACP_RUNTIME_IDLE_TTL_MS - 1);
    expect(f.state.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(f.state.close).toHaveBeenCalledTimes(5);
  });

  it("does not silently start fresh when an automatically reclaimed identity cannot resume", async () => {
    const f = fixture();
    const key = await f.spawn("lost");
    await f.send(key, "remember:APPLE");
    await vi.advanceTimersByTimeAsync(DEFAULT_ACP_RUNTIME_IDLE_TTL_MS);
    const identity = f.rows.get(key)?.identity;
    f.memory.clear();
    f.manager.stopIdleMaintenance();
    const restarted = new AcpSessionManager();
    managers.push(restarted);
    await expect(
      restarted.runTurn({
        cfg: baseCfg,
        sessionKey: key,
        text: "recall",
        mode: "prompt",
        requestId: "after-restart",
        provenance: "system",
      }),
    ).rejects.toThrow("Could not resume the ACP conversation");
    expect(f.state.ensureSession).toHaveBeenCalledTimes(2);
    expect(f.state.prepareFreshSession).not.toHaveBeenCalled();
    expect(f.rows.get(key)?.identity).toEqual(identity);
  });

  it("lets a newly queued user operation win over an idle eviction candidate", async () => {
    vi.useFakeTimers();
    const cache = new ManagerRuntimeHandleCache();
    const actorQueue = new SessionActorQueue();
    const state = createRuntime();
    const key = "agent:person_one:acp:queue-race";
    cache.set(key, {
      runtime: state.runtime,
      handle: {
        sessionKey: key,
        backend: "acpx",
        runtimeSessionName: key,
        backendSessionId: "stable-id",
      },
      backend: "acpx",
      agent: "codex",
      executionOwnerAgentId: "person_one",
      mode: "persistent",
      configSignature: "proof",
    });
    vi.advanceTimersByTime(DEFAULT_ACP_RUNTIME_IDLE_TTL_MS);
    const maintenance = cache.evictIdle({ actorQueue, activeTurnBySession: new Map() });
    const user = actorQueue.run(key, async () => {
      cache.get(key);
    });
    await Promise.all([maintenance, user]);
    expect(state.close).not.toHaveBeenCalled();
    expect(cache.has(key)).toBe(true);
    expect(actorQueue.getPendingCount(key)).toBe(0);
  });

  it("keeps failed releases owned and does not admit an extra physical process", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) {
      await f.spawn(`${i}`);
    }
    f.state.close.mockRejectedValue(new Error("process release failed"));
    await expect(f.spawn("sixth")).rejects.toThrow("capacity reached (5)");
    expect(f.state.ensureSession).toHaveBeenCalledTimes(5);
    expect(f.manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(5);
  });

  it("stops its periodic maintenance when the manager lifecycle ends", async () => {
    const f = fixture();
    await f.spawn("stop");
    expect(vi.getTimerCount()).toBe(1);
    f.manager.stopIdleMaintenance();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * DEFAULT_ACP_RUNTIME_IDLE_TTL_MS);
    expect(f.state.close).not.toHaveBeenCalled();
  });
});
