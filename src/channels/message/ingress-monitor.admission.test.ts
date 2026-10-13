import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { TurnAdoptionLifecycle } from "../../auto-reply/get-reply-options.types.js";
import { completeFollowupRunLifecycle } from "../../auto-reply/reply/queue/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { withPluginHttpRouteRegistry } from "../../plugins/http-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import * as pluginRuntimeBoundary from "../../plugins/runtime/runtime-plugin-boundary.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { importBundledChannelContractArtifact } from "../plugins/contracts/test-helpers/runtime-artifacts.js";
import type { ChannelPlugin } from "../plugins/types.js";
import type { ChannelInboundTurnPlan } from "./inbound-reply-dispatch.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
type Raw = { id: string; lane: string };
type Payload = { version: 1; rawEvent: string };

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("sequenced admission notification", () => {
  it("keeps concurrent append retries FIFO, snapshots active owners and isolates notice errors", async () => {
    const queue = createChannelIngressQueue<Payload>({
      channelId: "test",
      stateDir: tempDirs.make("ingress-notify-"),
    });
    const enqueue = queue.enqueue.bind(queue);
    let failed = false;
    vi.spyOn(queue, "enqueue").mockImplementation(async (...args) => {
      if (args[0] === "m" && !failed) {
        failed = true;
        throw new Error("synthetic append failure");
      }
      return await enqueue(...args);
    });
    const first = createDeferred<void>();
    const started: string[] = [];
    const errors: unknown[] = [];
    const notices: Array<{ id: string; count: number }> = [];
    const monitor = createChannelIngressMonitor<Raw, string, Payload>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: raw.lane }),
      payload: {
        version: 1,
        storage: "raw-event",
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as Raw,
        createClaimError: () => new Error("Invalid synthetic claim"),
      },
      deliver: async (raw, lifecycle) => {
        started.push(raw.id);
        await lifecycle.onAdopted();
        if (raw.id === "z") {
          await first.promise;
        }
      },
      sequencedAdmission: true,
      now: () => 7,
      appendRetryDelaysMs: [0, 0],
      pollIntervalMs: 10,
      retention: "standard",
      drain: { orderBy: "admission", adoptedLaneOccupancy: "hold" },
      onQueued: (raw, context) => {
        notices.push({ id: raw.id, count: context.aheadCount });
        throw new Error("synthetic notice failure");
      },
      onError: (error) => errors.push(error),
    });
    monitor.start();
    try {
      await monitor.admit({ id: "z", lane: "room" });
      await vi.waitFor(() => expect(started).toEqual(["z"]));
      await Promise.all([
        monitor.admit({ id: "m", lane: "room" }),
        monitor.admit({ id: "a", lane: "room" }),
      ]);
      expect(await monitor.admit({ id: "m", lane: "room" })).toMatchObject({
        queueResult: { duplicate: true },
      });
      await monitor.admit({ id: "other", lane: "other-room" });
      await monitor.admit({ id: "stop", lane: "room:control" });
      await vi.waitFor(() => expect(started).toContain("stop"));
      expect(notices).toEqual([
        { id: "m", count: 1 },
        { id: "a", count: 2 },
      ]);
      expect(errors).toHaveLength(2);
      first.resolve();
      await monitor.waitForIdle();
      expect(started.filter((id) => ["z", "m", "a"].includes(id))).toEqual(["z", "m", "a"]);
    } finally {
      first.resolve();
      await monitor.stop();
      vi.restoreAllMocks();
    }
  });

  it("retries an abandoned Knox followup without sending a contradictory terminal error", async () => {
    const sourceRoot = fileURLToPath(new URL("../../../extensions", import.meta.url));
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", sourceRoot);
    const resolveArtifact = vi.spyOn(pluginRuntimeBoundary, "resolvePluginRuntimeModulePath");
    const { knoxPlugin, setKnoxRuntime } = await importBundledChannelContractArtifact<{
      knoxPlugin: ChannelPlugin;
      setKnoxRuntime: (runtime: PluginRuntime) => void;
    }>("knox", "api.js");
    expect(resolveArtifact).toHaveReturnedWith(
      fileURLToPath(new URL("../../../extensions/knox/api.ts", import.meta.url)),
    );
    const startAccount = knoxPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("Knox gateway surface is missing");
    }
    const accountId = "synthetic";
    const cfg: OpenClawConfig = {
      channels: {
        knox: {
          accounts: {
            [accountId]: {
              enabled: true,
              webhookSecret: "w".repeat(32),
              serviceToken: "s".repeat(32),
              outboundUrl: "http://relay.invalid/send",
              controlPlaneUrl: "http://control.invalid/route",
              progressDelayMs: 60_000,
            },
          },
        },
      },
    };
    const message = {
      schemaVersion: 1,
      eventId: "evt-abandoned",
      messageId: "msg-abandoned",
      occurredAt: new Date(1).toISOString(),
      sender: { knoxUserId: "person.synthetic", displayName: "Synthetic Person" },
      conversation: { type: "room", providerType: "GROUP", conversationId: "room-synthetic" },
      message: { type: "text", text: "@platformclaw question" },
    };
    const queue = createChannelIngressQueue<Payload>({
      channelId: "knox",
      accountId,
      stateDir: tempDirs.make("knox-abandoned-retry-"),
      sequencedAdmission: true,
    });
    await queue.enqueue(
      message.messageId,
      { version: 1, rawEvent: JSON.stringify(message) },
      { laneKey: message.conversation.conversationId, admission: {} },
    );
    const sent: Array<{ messageId: string; status: string; final: boolean; text: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === "http://control.invalid/route") {
          return Response.json({
            status: "resolved",
            agentId: "room-agent",
            sessionKey: "agent:room-agent:main",
            senderLinked: true,
            executionTarget: null,
          });
        }
        expect(url).toBe("http://relay.invalid/send");
        if (typeof init.body !== "string") {
          throw new Error("Expected a synthetic JSON relay payload");
        }
        sent.push(JSON.parse(init.body) as (typeof sent)[number]);
        return Response.json({ ok: true, messageId: "synthetic-receipt" });
      }),
    );
    let attempts = 0;
    const abandoned = vi.fn();
    const run = async (params: {
      raw: unknown;
      turnAdoptionLifecycle: TurnAdoptionLifecycle;
      adapter: { resolveTurn: () => Promise<ChannelInboundTurnPlan> };
    }) => {
      expect(params.raw).toEqual(message);
      attempts += 1;
      const lifecycle = params.turnAdoptionLifecycle;
      if (attempts === 1) {
        const originalAbandoned = lifecycle.onAbandoned;
        lifecycle.onAbandoned = () => {
          abandoned();
          return originalAbandoned?.();
        };
        lifecycle.onDeferred?.();
        completeFollowupRunLifecycle({ turnAdoptionLifecycle: lifecycle });
      } else {
        await lifecycle.onAdopted();
        const turn = await params.adapter.resolveTurn();
        if (!("deliver" in turn.delivery) || !turn.delivery.deliver) {
          throw new Error("Missing Knox final delivery");
        }
        await turn.delivery.deliver({ text: "answer after retry" }, { kind: "final" });
      }
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: {},
        routeSessionKey: "agent:room-agent:main",
        dispatchResult: {
          queuedFinal: false,
          counts: { final: 0, block: 0, tool: 0 },
          noVisibleReplyFallbackEligible: true,
        },
      };
    };
    setKnoxRuntime({
      config: { current: () => cfg },
      state: { openChannelIngressQueue: () => queue },
      channel: { inbound: { buildContext: buildChannelInboundEventContext, run } },
    } as unknown as PluginRuntime);
    const abort = new AbortController();
    const registry = createEmptyPluginRegistry();
    const logs: string[] = [];
    const gateway = withPluginHttpRouteRegistry(registry, () =>
      startAccount({
        cfg,
        accountId,
        account: knoxPlugin.config.resolveAccount(cfg, accountId),
        log: {
          info: (logMessage) => logs.push(logMessage),
          warn: (logMessage) => logs.push(logMessage),
          error: (logMessage) => logs.push(logMessage),
        },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        abortSignal: abort.signal,
        getStatus: () => ({ accountId }),
        setStatus: vi.fn(),
      }),
    );
    try {
      // Real abandonment backoff is 1s; Knox polls every 500ms.
      await vi.waitFor(
        () =>
          expect({ attempts, sent, logs }).toMatchObject({
            attempts: 2,
            sent: [expect.objectContaining({ status: "final" })],
          }),
        { timeout: 3_000 },
      );
    } finally {
      abort.abort();
      await gateway;
    }
    expect(attempts).toBe(2);
    expect(abandoned).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      expect.objectContaining({
        messageId: message.messageId,
        status: "final",
        final: true,
        text: "answer after retry",
      }),
    ]);
    expect(await queue.listPending()).toEqual([]);
    expect(await queue.listClaims()).toEqual([]);
    expect(registry.httpRoutes).toEqual([]);
  });
});
