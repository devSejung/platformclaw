import { describe, expect, it } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager cache-only retirement", () => {
  installAcpSessionManagerTestLifecycle();

  it("is a cold no-op without reading metadata or ensuring a backend runtime", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:dashboard:cold",
      storeSessionKey: "agent:codex:dashboard:cold",
      acp: readySessionMeta(),
    });
    const manager = new AcpSessionManager();

    await expect(
      manager.closeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:dashboard:cold",
        reason: "session-archive",
        cacheOnly: true,
      }),
    ).resolves.toEqual({ runtimeClosed: false, metaCleared: false });

    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
  });

  it("closes a warm cached handle without mutating persisted resume metadata", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:dashboard:warm";
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta({
        identity: {
          state: "resolved",
          source: "status",
          agentSessionId: "agent-resume-id",
          lastUpdatedAt: Date.now(),
        },
      }),
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "warm it",
      mode: "prompt",
      requestId: "warm-1",
    });
    hoisted.upsertAcpSessionMetaMock.mockClear();
    runtimeState.close.mockClear();

    await expect(
      manager.closeSession({
        cfg: baseCfg,
        sessionKey,
        reason: "session-archive",
        cacheOnly: true,
      }),
    ).resolves.toEqual({ runtimeClosed: true, metaCleared: false });

    expectRecordFields(mockCallArg(runtimeState.close), {
      reason: "session-archive",
    });
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
  });

  it("keeps the exact warm handle cached when lifecycle retirement fails so it can retry", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:dashboard:warm-retry";
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta(),
    });
    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "warm it",
      mode: "prompt",
      requestId: "warm-retry-1",
    });
    runtimeState.close.mockReset();
    runtimeState.close
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValueOnce(undefined);

    await expect(
      manager.closeSession({
        cfg: baseCfg,
        sessionKey,
        reason: "session-archive",
        cacheOnly: true,
      }),
    ).rejects.toThrow("close failed");
    await expect(
      manager.closeSession({
        cfg: baseCfg,
        sessionKey,
        reason: "session-archive",
        cacheOnly: true,
      }),
    ).resolves.toEqual({ runtimeClosed: true, metaCleared: false });

    expect(runtimeState.close).toHaveBeenCalledTimes(2);
  });
});
