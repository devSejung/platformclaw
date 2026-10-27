import { describe, expect, it, vi } from "vitest";
import {
  hasPendingAgentWork,
  tryAcquireAgentWorkMutation,
} from "../../agents/agent-work-admission.js";
import {
  AcpSessionManager,
  baseCfg,
  createDeferred,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("ACP owner work admission", () => {
  installAcpSessionManagerTestLifecycle();
  const sessionKey = "agent:coding:acp:admission";
  const turn = {
    cfg: baseCfg,
    sessionKey,
    provenance: "system" as const,
    text: "work",
    mode: "prompt" as const,
    requestId: "turn",
  };

  function configure(owner: string) {
    const runtime = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta({ agent: "coding", executionOwnerAgentId: owner }),
    });
    return runtime;
  }

  it("rejects a warm turn under its stored execution owner before backend effects", async () => {
    const runtime = configure("warm-owner");
    const manager = new AcpSessionManager();
    await manager.runTurn(turn);
    const release = tryAcquireAgentWorkMutation("warm-owner");
    expect(release).not.toBeNull();
    try {
      await expect(manager.runTurn({ ...turn, requestId: "blocked" })).rejects.toThrow(
        "Retry when it completes",
      );
      expect(runtime.runTurn).toHaveBeenCalledTimes(1);
      expect(runtime.ensureSession).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
      await manager.stopIdleMaintenance();
    }
    expect(hasPendingAgentWork("warm-owner")).toBe(false);
  });

  it("holds owner claims through the actor queue and runtime completion", async () => {
    const runtime = configure("queued-owner");
    const firstGate = createDeferred();
    const secondGate = createDeferred();
    runtime.runTurn.mockImplementation(async function* (input) {
      await (input.requestId === "first" ? firstGate : secondGate).promise;
      yield { type: "done" as const };
    });
    const manager = new AcpSessionManager();
    const first = manager.runTurn({ ...turn, requestId: "first" });
    const second = manager.runTurn({ ...turn, requestId: "second" });
    try {
      expect(hasPendingAgentWork("queued-owner")).toBe(true);
      expect(hasPendingAgentWork("coding")).toBe(false);
      expect(tryAcquireAgentWorkMutation("queued-owner")).toBeNull();
      await vi.waitFor(() => expect(runtime.runTurn).toHaveBeenCalledTimes(1));
      firstGate.resolve();
      await first;
      await vi.waitFor(() => expect(runtime.runTurn).toHaveBeenCalledTimes(2));
      expect(tryAcquireAgentWorkMutation("queued-owner")).toBeNull();
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await Promise.all([first, second]);
      await manager.stopIdleMaintenance();
    }
    expect(hasPendingAgentWork("queued-owner")).toBe(false);
  });

  it("preserves the initializer's requester owner before ACP metadata exists", async () => {
    const runtime = createRuntime();
    const ensureGate = createDeferred();
    let meta: SessionAcpMeta | undefined;
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
    hoisted.readAcpSessionEntryMock.mockImplementation(() =>
      meta ? { sessionKey, storeSessionKey: sessionKey, acp: meta } : null,
    );
    hoisted.upsertAcpSessionMetaMock.mockImplementation(
      async (input: { mutate: (current: SessionAcpMeta | undefined) => SessionAcpMeta }) => {
        meta = input.mutate(meta);
        return { sessionId: "admission", updatedAt: Date.now(), acp: meta };
      },
    );
    runtime.ensureSession.mockImplementation(async (input) => {
      await ensureGate.promise;
      return { sessionKey: input.sessionKey, backend: "acpx", runtimeSessionName: "initialized" };
    });
    const manager = new AcpSessionManager();
    const initialize = manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "coding",
      executionOwnerAgentId: "initializing-owner",
      mode: "persistent",
    });
    const queued = manager.runTurn(turn);
    try {
      expect(hasPendingAgentWork("initializing-owner")).toBe(true);
      expect(hasPendingAgentWork("coding")).toBe(false);
      expect(tryAcquireAgentWorkMutation("initializing-owner")).toBeNull();
    } finally {
      ensureGate.resolve();
      await Promise.all([initialize, queued]);
      await manager.stopIdleMaintenance();
    }
    expect(hasPendingAgentWork("initializing-owner")).toBe(false);
  });

  it("releases a cancelled queued turn without releasing the running owner's claim", async () => {
    const runtime = configure("cancelled-owner");
    const gate = createDeferred();
    runtime.runTurn.mockImplementation(async function* () {
      await gate.promise;
      yield { type: "done" as const };
    });
    const manager = new AcpSessionManager();
    const first = manager.runTurn(turn);
    const controller = new AbortController();
    try {
      await vi.waitFor(() => expect(runtime.runTurn).toHaveBeenCalledOnce());
      const queued = manager.runTurn({
        ...turn,
        requestId: "cancelled",
        signal: controller.signal,
      });
      controller.abort(new Error("queued cancellation"));
      await expect(queued).rejects.toThrow("ACP operation aborted");
      expect(hasPendingAgentWork("cancelled-owner")).toBe(true);
      expect(runtime.runTurn).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await first;
      await manager.stopIdleMaintenance();
    }
    expect(hasPendingAgentWork("cancelled-owner")).toBe(false);
  });

  it("releases a failed runtime turn's owner claim", async () => {
    const runtime = configure("failed-owner");
    runtime.runTurn.mockImplementation(async function* () {
      throw new Error("runtime failed");
    });
    const manager = new AcpSessionManager();
    try {
      await expect(manager.runTurn(turn)).rejects.toThrow("runtime failed");
      expect(hasPendingAgentWork("failed-owner")).toBe(false);
    } finally {
      await manager.stopIdleMaintenance();
    }
  });
});
