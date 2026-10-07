/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { patchSettings } from "../../app/settings.ts";
import type { ActivityEntry } from "./tool-activity.ts";
import "./activity-page.ts";

type TestActivityPage = HTMLElement & {
  context: ApplicationContext;
  entries: ActivityEntry[];
  subscriptions: {
    hostConnected: () => void;
    hostUpdate: () => void;
    hostDisconnected: () => void;
  };
};

function gateway(
  eventLog: ApplicationContext["gateway"]["eventLog"] = [],
): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client: null,
    phase: "stopped",
    offlineStable: false,
    canvasPluginSurfaceRoute: { mode: "direct" },
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    eventLog,
    subscribe: vi.fn(() => () => undefined),
    subscribeEvents: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

function staleEntry(): ActivityEntry {
  return {
    id: "stale",
    toolCallId: "stale",
    runId: "stale",
    toolName: "stale",
    entryKind: "tool",
    status: "done",
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    outputTruncated: false,
    summary: "stale",
    hiddenArgumentCount: 0,
  };
}

afterEach(() => {
  localStorage.clear();
});

describe("ActivityPage gateway lifecycle", () => {
  it.each([true, false])(
    "applies catalog visibility to replayed and live activity (hidden: %s)",
    (hidden) => {
      const hiddenKey = "agent:main:embedded:12345678-90ab-cdef-1234-567890abcdef";
      const sessionKey = hidden ? hiddenKey : "agent:main:main";
      patchSettings({ sessionKey });
      const payload = {
        sessionKey,
        runId: "run",
        stream: "tool",
        ts: 1,
        data: { toolCallId: "replayed", name: "read", phase: "result", result: "Stored output" },
      };
      const source = gateway([{ ts: 1, event: "session.tool", payload }]);
      const page = document.createElement("openclaw-activity-page") as TestActivityPage;
      page.context = {
        gateway: source,
        sessionCatalogFilter: (key: string) => key !== hiddenKey,
      } as unknown as ApplicationContext;
      page.subscriptions.hostConnected();
      expect(page.entries).toHaveLength(hidden ? 0 : 1);
      const emit = vi.mocked(source.subscribeEvents).mock.calls[0]![0];
      for (const eventKey of [sessionKey, undefined]) {
        emit({
          type: "event",
          event: "session.tool",
          payload: {
            ...payload,
            sessionKey: eventKey,
            data: { ...payload.data, toolCallId: eventKey ?? "unscoped" },
          },
        });
      }
      expect(page.entries).toHaveLength(hidden ? 0 : 3);
      page.subscriptions.hostDisconnected();
    },
  );

  it("replays the active gateway on initial bind and source replacement", () => {
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = { gateway: gateway() } as unknown as ApplicationContext;
    page.entries = [staleEntry()];

    page.subscriptions.hostConnected();
    expect(page.entries).toEqual([]);

    page.entries = [staleEntry()];
    page.context = { gateway: gateway() } as unknown as ApplicationContext;
    page.subscriptions.hostUpdate();
    expect(page.entries).toEqual([]);

    page.subscriptions.hostDisconnected();
  });
});
