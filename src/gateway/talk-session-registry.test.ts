import { describe, expect, it, vi } from "vitest";
import {
  cleanupTalkConnection,
  registerTalkConnectionCleanup,
  withTalkConnectionCreation,
} from "./talk-session-registry.js";

describe("Talk connection cleanup registry", () => {
  it("keeps one cleanup per relay kind and forgets the connection before running them", async () => {
    const replacedRealtimeCleanup = vi.fn();
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };
    const realtimeCleanup = vi.fn(() => cleanupTalkConnection("conn-dedupe", log));

    registerTalkConnectionCleanup("conn-dedupe", "realtime-relay", replacedRealtimeCleanup);
    registerTalkConnectionCleanup("conn-dedupe", "realtime-relay", realtimeCleanup);
    registerTalkConnectionCleanup("conn-dedupe", "transcription-relay", transcriptionCleanup);

    await cleanupTalkConnection("conn-dedupe", log);
    await cleanupTalkConnection("conn-dedupe", log);

    expect(replacedRealtimeCleanup).not.toHaveBeenCalled();
    expect(realtimeCleanup).toHaveBeenCalledOnce();
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("continues cleanup after one relay owner throws", async () => {
    const cleanupError = new Error("realtime cleanup failed");
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };

    registerTalkConnectionCleanup("conn-error", "realtime-relay", () => {
      throw cleanupError;
    });
    registerTalkConnectionCleanup("conn-error", "transcription-relay", transcriptionCleanup);

    await cleanupTalkConnection("conn-error", log);

    expect(log.warn).toHaveBeenCalledWith(
      "failed to run realtime-relay Talk cleanup after connection disconnect: realtime cleanup failed",
    );
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
  });

  it("fences all owners synchronously and waits for async cleanup despite another rejection", async () => {
    const log = { warn: vi.fn() };
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realtimeCleanup = vi.fn(async () => {
      await waiting;
    });
    const clientCleanup = vi.fn(async () => {
      throw new Error("native cleanup failed");
    });
    const transcriptionCleanup = vi.fn();
    registerTalkConnectionCleanup("conn-async", "realtime-relay", realtimeCleanup);
    registerTalkConnectionCleanup("conn-async", "client", clientCleanup);
    registerTalkConnectionCleanup("conn-async", "transcription-relay", transcriptionCleanup);

    let completed = false;
    const disconnecting = cleanupTalkConnection("conn-async", log).then(() => {
      completed = true;
    });
    expect(realtimeCleanup).toHaveBeenCalledOnce();
    expect(clientCleanup).toHaveBeenCalledOnce();
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
    await cleanupTalkConnection("conn-async", log);
    expect(completed).toBe(false);
    release?.();
    await disconnecting;

    expect(completed).toBe(true);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      "failed to run client Talk cleanup after connection disconnect: native cleanup failed",
    );
  });

  it("fences concurrent creation plans only for the disconnected connection", async () => {
    const log = { warn: vi.fn() };
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effect = vi.fn();
    const create = async (assertActive: () => void) => {
      await waiting;
      assertActive();
      effect();
    };
    const first = withTalkConnectionCreation("conn-planning", create);
    const second = withTalkConnectionCreation("conn-planning", create);
    const unrelated = withTalkConnectionCreation("conn-other-plan", create);
    await cleanupTalkConnection("conn-planning", log);
    release?.();
    const results = await Promise.allSettled([first, second, unrelated]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect(effect).toHaveBeenCalledOnce();
    await cleanupTalkConnection("conn-other-plan", log);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("releases a completed or failed plan without removing the concrete session's cleanup", async () => {
    const log = { warn: vi.fn() };
    const cleanup = vi.fn();
    await expect(
      withTalkConnectionCreation("conn-adoption", async () => {
        throw new Error("planning failed");
      }),
    ).rejects.toThrow("planning failed");
    await withTalkConnectionCreation("conn-adoption", async (assertActive) => {
      assertActive();
      registerTalkConnectionCleanup("conn-adoption", "realtime-relay", cleanup);
    });
    await cleanupTalkConnection("conn-adoption", log);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
