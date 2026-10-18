import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadNoVisibleReplyReason,
  setReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { dispatchChannelInboundTurn, hasVisibleChannelTurnDispatch } from "./kernel.js";
import type { ChannelDeliveryOutcome, ChannelTurnPlan } from "./types.js";

let stateDir: string;
let cfg: OpenClawConfig;
let sessionKey: string;
let storePath: string;

beforeEach(async () => {
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "turn-visibility-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  sessionKey = `agent:main:test:direct:${randomUUID()}`;
  cfg = {
    plugins: { enabled: false },
    agents: { defaults: { workspace: path.join(stateDir, "workspace") } },
    session: { store: storePath },
  };
  await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(cfg));
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(stateDir, { recursive: true, force: true });
});

async function runTurn(
  overrides: Pick<ChannelTurnPlan, "delivery" | "replyResolver"> & {
    dispatcherOptions?: ChannelTurnPlan["dispatcherOptions"];
  },
) {
  return await dispatchChannelInboundTurn({
    cfg,
    channel: "test",
    route: { agentId: "main", sessionKey },
    ctxPayload: {
      Body: "Please answer",
      RawBody: "Please answer",
      CommandBody: "Please answer",
      From: "test:sender",
      To: "test:target",
      SessionKey: sessionKey,
      MessageSid: randomUUID(),
      Provider: "test",
      Surface: "test",
      ChatType: "direct",
      CommandAuthorized: false,
    },
    ...overrides,
  });
}

describe("native visibility through real dispatch and channel settlement", () => {
  it.each([false, true])(
    "subtracts native suppression once with beforeDeliver cancellation=%s",
    async (cancelBeforeDeliver) => {
      const deliver = vi.fn(async (payload: { text?: string }) =>
        payload.text === "suppressed"
          ? { visibleReplySent: false, suppression: { reason: "no_visible_result" as const } }
          : { visibleReplySent: true },
      );
      const result = await runTurn({
        replyResolver: async () => [
          ...(cancelBeforeDeliver ? [{ text: "cancelled" }] : []),
          { text: "suppressed" },
          { text: "visible" },
        ],
        dispatcherOptions: {
          beforeDeliver: (payload) => (payload.text === "cancelled" ? null : payload),
        },
        delivery: { deliver },
      });
      expect(result.dispatched).toBe(true);
      if (!result.dispatched) {
        throw new Error("Expected a dispatched turn");
      }
      expect(deliver.mock.calls.map(([payload]) => payload.text)).toEqual([
        "suppressed",
        "visible",
      ]);
      expect(result.dispatchResult.counts).toEqual({ tool: 0, block: 0, final: 1 });
      expect(result.dispatchResult.queuedFinal).toBe(true);
      expect(hasVisibleChannelTurnDispatch(result.dispatchResult)).toBe(true);
    },
  );

  it("keeps the turn nonvisible when native policy suppresses the answer and directed recovery", async () => {
    const deliver = vi.fn(async (_payload: { text?: string }) => ({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" as const },
    }));
    const result = await runTurn({
      replyResolver: async () => ({ text: "suppressed" }),
      delivery: { deliver },
    });
    expect(result.dispatched).toBe(true);
    if (!result.dispatched) {
      throw new Error("Expected a dispatched turn");
    }
    expect(deliver.mock.calls[0]?.[0].text).toBe("suppressed");
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(getReplyPayloadNoVisibleReplyReason(deliver.mock.calls[1]![0])).toBe(
      "delivery-suppressed",
    );
    expect(result.dispatchResult.noVisibleReplyReason).toBe("delivery-suppressed");
    expect(result.dispatchResult.counts.final).toBe(0);
    expect(result.dispatchResult.queuedFinal).toBe(false);
    expect(hasVisibleChannelTurnDispatch(result.dispatchResult)).toBe(false);
  });

  it.each([true, false])(
    "waits for onIdle native visibility=%s before reconciling replay",
    async (visibleReplySent) => {
      const payload = { text: "deferred answer" };
      setReplyPayloadMetadata(payload, {
        pendingFinalDeliveryIntentId: "deferred-intent",
        pendingFinalDeliveryRetryText: payload.text,
      });
      await replaceSessionEntry(
        { storePath, sessionKey },
        {
          sessionId: "deferred-session",
          updatedAt: Date.now(),
          pendingFinalDelivery: {
            kind: "replayable",
            text: payload.text,
            intentId: "deferred-intent",
            createdAt: Date.now(),
          },
        },
      );
      let resolveFinalization!: (outcome: ChannelDeliveryOutcome) => void;
      const finalization = new Promise<ChannelDeliveryOutcome>((resolve) => {
        resolveFinalization = resolve;
      });
      const events: string[] = [];
      const deliver = vi.fn(async () => {
        events.push("buffered");
        return { visibleReplySent: false, finalization };
      });
      const onDelivered = vi.fn();
      const result = await runTurn({
        replyResolver: async () => payload,
        dispatcherOptions: {
          onIdle: () => {
            if (events.includes("idle")) {
              return;
            }
            events.push("idle");
            expect(loadSessionEntry({ storePath, sessionKey })?.pendingFinalDelivery).toBeDefined();
            resolveFinalization({ visibleReplySent });
          },
        },
        delivery: { deliver, onDelivered },
      });
      expect(events).toEqual(["buffered", "idle"]);
      expect(deliver).toHaveBeenCalledOnce();
      expect(onDelivered).toHaveBeenCalledOnce();
      expect(onDelivered.mock.calls[0]?.[2]).toMatchObject({ visibleReplySent });
      expect(result.dispatched).toBe(true);
      if (!result.dispatched) {
        throw new Error("Expected a dispatched turn");
      }
      expect(result.dispatchResult.counts.final).toBe(visibleReplySent ? 1 : 0);
      const pending = loadSessionEntry({ storePath, sessionKey })?.pendingFinalDelivery;
      expect(pending === undefined).toBe(visibleReplySent);
    },
  );

  it("reconciles deferred native suppression beside a visible final", async () => {
    let resolveFinalization!: (outcome: ChannelDeliveryOutcome) => void;
    const finalization = new Promise<ChannelDeliveryOutcome>((resolve) => {
      resolveFinalization = resolve;
    });
    const deliver = vi.fn(async (payload: { text?: string }) =>
      payload.text === "deferred"
        ? {
            visibleReplySent: false,
            suppression: { reason: "no_visible_result" as const },
            finalization,
          }
        : { visibleReplySent: true },
    );
    const result = await runTurn({
      replyResolver: async () => [{ text: "deferred" }, { text: "visible" }],
      dispatcherOptions: { onIdle: () => resolveFinalization({ visibleReplySent: false }) },
      delivery: { deliver },
    });
    expect(result.dispatched).toBe(true);
    if (!result.dispatched) {
      throw new Error("Expected a dispatched turn");
    }
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(result.dispatchResult.counts.final).toBe(1);
    expect(result.dispatchResult.queuedFinal).toBe(true);
  });
});
