/** Targeted system-event routing and wake behavior. */

import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG,
  SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS,
} from "../../../packages/gateway-protocol/src/schema.js";
import {
  drainSystemEvents,
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
  SystemEventQueueFullError,
} from "../../infra/system-events.js";
import { listSystemPresence, updateSystemPresence } from "../../infra/system-presence.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  requestHeartbeat: vi.fn(),
  loadGatewaySessionRow: vi.fn(),
}));

vi.mock("../../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/heartbeat-wake.js")>()),
  requestHeartbeat: mocks.requestHeartbeat,
}));

vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionRow: mocks.loadGatewaySessionRow,
}));

import { systemHandlers } from "./system.js";

describe("system-event routing", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  afterEach(() => {
    resetSystemEventsForTest();
    mocks.requestHeartbeat.mockReset();
    mocks.loadGatewaySessionRow.mockReset();
  });

  it("queues and immediately wakes the requested session", async () => {
    const respond = vi.fn();
    const sessionKey = "agent:main:main";
    mocks.loadGatewaySessionRow.mockReturnValue({ key: sessionKey, archived: false });
    const request = {
      params: {
        text: "OpenClaw updated. Welcome the user back.",
        sessionKey,
        wake: true,
      },
      respond,
      context: {
        broadcast: vi.fn(),
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
        getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
      },
    } as unknown as GatewayRequestHandlerOptions;

    await expectDefined(
      systemHandlers["system-event"],
      'systemHandlers["system-event"] test invariant',
    )(request);

    expect(peekSystemEvents(sessionKey)).toEqual(["OpenClaw updated. Welcome the user back."]);
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey,
      heartbeat: { target: "last" },
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("reports retryable queue saturation without evicting accepted events or waking", async () => {
    const sessionKey = "agent:main:main";
    mocks.loadGatewaySessionRow.mockReturnValue({ key: sessionKey, archived: false });
    const pending = Array.from({ length: 20 }, (_, index) => `pending ${index}`);
    for (const text of pending) {
      enqueueSystemEvent(text, { sessionKey });
    }
    const respond = vi.fn();
    const instanceId = `event-overflow-${randomUUID()}`;
    const request = {
      params: { text: "retry me", sessionKey, wake: true, instanceId },
      respond,
      context: {
        broadcast: vi.fn(),
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
        getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
      },
    } as unknown as GatewayRequestHandlerOptions;
    const handler = expectDefined(systemHandlers["system-event"], "system-event handler");
    await handler(request);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: new SystemEventQueueFullError().message,
        retryable: true,
      }),
    );
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(listSystemPresence().find((entry) => entry.instanceId === instanceId)).toBeUndefined();
    expect(request.context.broadcast).not.toHaveBeenCalled();
    expect(drainSystemEvents(sessionKey)).toEqual(pending);
    respond.mockClear();
    await handler(request);
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(peekSystemEvents(sessionKey)).toEqual(["retry me"]);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it.each(["new", "existing"])(
    "preserves %s node metadata when queue admission fails so retry can emit its delta",
    async (kind) => {
      const sessionKey = "agent:main:main";
      const instanceId = `node-overflow-${randomUUID()}`;
      if (kind === "existing") {
        updateSystemPresence({
          text: "Node: previous",
          instanceId,
          host: "previous",
          version: "1.0.0",
        });
      }
      const previous = listSystemPresence().find((entry) => entry.instanceId === instanceId);
      for (let index = 0; index < 20; index += 1) {
        enqueueSystemEvent(`pending ${index}`, { sessionKey });
      }
      const respond = vi.fn();
      const context = {
        broadcast: vi.fn(),
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
      };
      const request = {
        params: {
          text: "Node: updated",
          host: "updated",
          version: "2.0.0",
          sessionKey,
          instanceId,
        },
        respond,
        context,
      } as unknown as GatewayRequestHandlerOptions;
      const handler = expectDefined(systemHandlers["system-event"], "system-event handler");
      await handler(request);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          retryable: true,
        }),
      );
      expect(listSystemPresence().find((entry) => entry.instanceId === instanceId)).toEqual(
        previous,
      );
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(drainSystemEvents(sessionKey)).toHaveLength(20);

      respond.mockClear();
      await handler(request);
      expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(peekSystemEvents(sessionKey)).toEqual(["Node: updated · app 2.0.0"]);
      expect(listSystemPresence().find((entry) => entry.instanceId === instanceId)?.version).toBe(
        "2.0.0",
      );
      expect(context.broadcast).toHaveBeenCalledOnce();
    },
  );

  it("still updates noisy node heartbeat presence while the event queue is full", async () => {
    const instanceId = `node-heartbeat-${randomUUID()}`;
    const sessionKey = "agent:main:main";
    const payload = { text: "Node: heartbeat", host: "heartbeat", instanceId, reason: "heartbeat" };
    updateSystemPresence(payload);
    for (let index = 0; index < 20; index += 1) {
      enqueueSystemEvent(`pending ${index}`, { sessionKey });
    }
    const respond = vi.fn();
    const broadcast = vi.fn();
    await expectDefined(
      systemHandlers["system-event"],
      "system-event handler",
    )({
      params: { ...payload, sessionKey, lastInputSeconds: 42 },
      respond,
      context: {
        broadcast,
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
      },
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(
      listSystemPresence().find((entry) => entry.instanceId === instanceId)?.lastInputSeconds,
    ).toBe(42);
    expect(peekSystemEvents(sessionKey)).toHaveLength(20);
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it("rejects immediate wakes for unconfigured agents", async () => {
    const respond = vi.fn();
    const request = {
      params: {
        text: "OpenClaw updated. Welcome the user back.",
        sessionKey: "agent:bogus:main",
        wake: true,
      },
      respond,
      context: {
        broadcast: vi.fn(),
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
        getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
      },
    } as unknown as GatewayRequestHandlerOptions;

    await expectDefined(
      systemHandlers["system-event"],
      'systemHandlers["system-event"] test invariant',
    )(request);

    expect(peekSystemEvents("agent:bogus:main")).toEqual([]);
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: 'Unknown agent id "bogus"' }),
    );
  });

  it("rejects immediate wakes for missing sessions", async () => {
    const respond = vi.fn();
    const sessionKey = "agent:main:missing";
    mocks.loadGatewaySessionRow.mockReturnValue(null);
    const request = {
      params: {
        text: "OpenClaw updated. Welcome the user back.",
        sessionKey,
        wake: true,
      },
      respond,
      context: {
        broadcast: vi.fn(),
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
        getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
      },
    } as unknown as GatewayRequestHandlerOptions;

    await expectDefined(
      systemHandlers["system-event"],
      'systemHandlers["system-event"] test invariant',
    )(request);

    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: `Unknown or archived session "${sessionKey}"` }),
    );
  });

  it("rejects wake requests mixed with node presence events", async () => {
    const respond = vi.fn();
    const sessionKey = "agent:main:main";
    const request = {
      params: {
        text: "Node: Operator Mac",
        deviceId: "device-1",
        sessionKey,
        wake: true,
      },
      respond,
      context: {
        broadcast: vi.fn(),
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
        getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
      },
    } as unknown as GatewayRequestHandlerOptions;

    await expectDefined(
      systemHandlers["system-event"],
      'systemHandlers["system-event"] test invariant',
    )(request);

    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(mocks.loadGatewaySessionRow).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "wake is not supported for node presence events" }),
    );
  });

  it("passes explicit input activity clearing into system presence", async () => {
    const instanceId = `presence-clear-${randomUUID()}`;
    const handler = expectDefined(
      systemHandlers["system-event"],
      'systemHandlers["system-event"] test invariant',
    );
    const context = {
      broadcast: vi.fn(),
      incrementPresenceVersion: vi.fn(() => 1),
      getHealthVersion: vi.fn(() => 1),
      getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
    };

    await handler({
      params: {
        text: "Node: Operator Mac",
        instanceId,
        host: "Operator Mac",
        mode: "ui",
        lastInputSeconds: 5,
      },
      respond: vi.fn(),
      context,
    } as unknown as GatewayRequestHandlerOptions);
    await handler({
      params: {
        text: "Node: Operator Mac",
        instanceId,
        host: "Operator Mac",
        mode: "ui",
        lastInputSeconds: SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS,
        tags: [SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG],
      },
      respond: vi.fn(),
      context,
    } as unknown as GatewayRequestHandlerOptions);

    const entry = listSystemPresence().find((candidate) => candidate.instanceId === instanceId);
    expect(entry?.lastInputSeconds).toBeUndefined();
  });
});
