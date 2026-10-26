import { beforeEach, describe, expect, it, vi } from "vitest";
import type { consultRealtimeVoiceAgent } from "../talk/agent-consult-runtime.js";
import { createTalkClientConsultRunner } from "./talk-client-consult.js";
import { TalkClientSessionOwner } from "./talk-client-session-owner.js";

const mocks = vi.hoisted(() => ({
  consult: vi.fn<typeof consultRealtimeVoiceAgent>(),
  assertOpen: vi.fn(),
  registerRun: vi.fn(),
}));
vi.mock("../talk/agent-consult-runtime.js", () => ({ consultRealtimeVoiceAgent: mocks.consult }));
vi.mock("../talk/client-voice-session.js", () => ({
  assertClientVoiceSessionOpen: mocks.assertOpen,
  registerClientVoiceConsultRun: mocks.registerRun,
}));
vi.mock("../plugins/runtime/index.js", () => ({ createPluginRuntime: () => ({ agent: {} }) }));

beforeEach(() => {
  vi.resetAllMocks();
});

function fixture() {
  const owner = new TalkClientSessionOwner();
  const runner = createTalkClientConsultRunner({
    config: {},
    context: { logGateway: { warn: vi.fn() }, chatAbortControllers: new Map() },
    agentId: "main",
    sessionKey: "agent:main:voice",
    connId: "native-owner",
    initialItems: [],
    owner,
    getVoiceSessionId: () => "native-voice",
  });
  return { owner, runner };
}

describe("native Talk consult admission", () => {
  it("rejects a closed canonical voice record after awaited setup and before starting a run", async () => {
    const { runner } = fixture();
    let finishSetup: (() => void) | undefined;
    let canonicalOpen = true;
    mocks.assertOpen.mockImplementation(() => {
      if (!canonicalOpen) {
        throw new Error("voice session is closed");
      }
    });
    const effect = vi.fn();
    mocks.consult.mockImplementation(async (params) => {
      await new Promise<void>((resolve) => {
        finishSetup = resolve;
      });
      params.onRunStarted?.({
        runId: "late-consult",
        sessionId: "session-main",
        timeoutMs: 30_000,
      });
      effect();
      return { text: "Should not run" };
    });
    const running = runner({ prompt: "Check the repository" });
    canonicalOpen = false;
    finishSetup?.();
    await expect(running).rejects.toThrow("voice session is closed");
    expect(mocks.assertOpen).toHaveBeenCalledTimes(2);
    expect(mocks.registerRun).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it("keeps an admitted run alive on transport close while rejecting later consultations", async () => {
    const { owner, runner } = fixture();
    const provider = new AbortController();
    owner.attachCancellation(async () => provider.abort(new Error("transport closed")));
    let finishRun: (() => void) | undefined;
    let runSignal: AbortSignal | undefined;
    mocks.consult.mockImplementation(async (params) => {
      const registration = params.onRunStarted?.({
        runId: "active-consult",
        sessionId: "session-main",
        timeoutMs: 30_000,
      });
      runSignal = params.abortSignal;
      try {
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        });
        return { text: "Completed under the existing run authority" };
      } finally {
        registration?.cleanup?.();
      }
    });
    const running = runner({ prompt: "Complete the requested action", signal: provider.signal });
    await owner.cancel();
    expect(runSignal?.aborted).toBe(false);
    await expect(runner({ prompt: "A new action" })).rejects.toThrow("voice session is closed");
    finishRun?.();
    await expect(running).resolves.toEqual({ text: "Completed under the existing run authority" });
  });
});
