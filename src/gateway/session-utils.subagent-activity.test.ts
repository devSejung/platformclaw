import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.test-helpers.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  createLifecycleEventBroadcastHandler,
  createTranscriptUpdateBroadcastHandler,
} from "./server-session-events.js";
import { buildGatewaySessionEventRow } from "./session-event-payload.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";
import { listSessionsFromStore, listSessionsFromStoreAsync } from "./session-utils.js";

const cfg = {
  agents: { list: [{ id: "main", default: true }] },
} as OpenClawConfig;
const parentKey = "agent:main:dashboard:parent";
const childKey = "agent:main:subagent:child";
const otherParentKey = "agent:main:dashboard:other-parent";
const storePath = "/tmp/openclaw-subagent-activity/sessions.json";

afterEach(() => {
  resetAgentEventsForTest({ preserveListeners: true });
  resetSubagentRegistryForTests({ persist: false });
  resetConfigRuntimeState();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createStore(now: number): Record<string, SessionEntry> {
  return {
    [parentKey]: { sessionId: "parent-session", updatedAt: now, status: "done" },
    [otherParentKey]: { sessionId: "other-session", updatedAt: now - 1 },
    [childKey]: {
      sessionId: "child-session",
      updatedAt: now - 2,
      spawnedBy: parentKey,
      status: "running",
    },
  };
}

function addRun(now: number, controllerSessionKey = parentKey, endedAt?: number): void {
  addSubagentRunForTests({
    runId: "child-run",
    childSessionKey: childKey,
    controllerSessionKey,
    requesterSessionKey: parentKey,
    requesterDisplayKey: "parent",
    task: "child work",
    cleanup: "keep",
    createdAt: now - 1_000,
    startedAt: now - 900,
    ...(endedAt === undefined ? {} : { endedAt, outcome: { status: "ok" } }),
  });
}

describe("parent subagent activity projection", () => {
  test.each([
    { name: "live child", state: "live", active: true },
    { name: "ended child", state: "ended", active: false },
    { name: "interrupted registry snapshot", state: "interrupted", active: false },
    { name: "store-only fork", state: "fork", active: false },
    { name: "child moved to another controller", state: "moved", active: false },
    { name: "live child with explicit navigation parent", state: "navigation", active: true },
  ])(
    "projects $name consistently for full lists and single-row snapshots",
    async ({ state, active }) => {
      const now = Date.now();
      const store = createStore(now);
      const childEntry = expectDefined(store[childKey], "child session");
      if (state === "fork") {
        store[childKey] = {
          ...childEntry,
          parentSessionKey: parentKey,
          forkedFromParent: true,
        };
      } else {
        addRun(
          now,
          state === "moved" || state === "navigation" ? otherParentKey : parentKey,
          state === "ended" ? now - 500 : undefined,
        );
        if (state !== "interrupted") {
          registerAgentRunContext("child-run", { sessionKey: childKey });
        }
        if (state === "navigation") {
          store[childKey] = { ...childEntry, parentSessionKey: parentKey };
        }
      }
      const input = { cfg, storePath, store, opts: { limit: 1 } };
      const sync = listSessionsFromStore(input).sessions[0];
      const asyncRow = (await listSessionsFromStoreAsync(input)).sessions[0];
      const single = buildGatewaySessionRow({
        cfg,
        storePath,
        store,
        key: parentKey,
        entry: store[parentKey],
        now,
      });
      for (const row of [sync, asyncRow, single, buildGatewaySessionEventRow(single)]) {
        expect(row?.key).toBe(parentKey);
        expect(row?.hasActiveSubagentRun === true).toBe(active);
        expect(row?.activeChildSessions).toEqual(active ? [childKey] : []);
        // Child work must not rewrite the parent's own completed lifecycle.
        expect(row?.status).toBe("done");
        expect(row?.subagentRunState).toBeUndefined();
      }
    },
  );

  test("clears parent activity after child completion despite a retained child link", () => {
    const now = Date.now();
    const store = createStore(now);
    addRun(now);
    registerAgentRunContext("child-run", { sessionKey: childKey });
    const list = () => listSessionsFromStore({ cfg, storePath, store, opts: { limit: 1 } });
    expect(list().sessions[0]?.hasActiveSubagentRun).toBe(true);

    clearAgentRunContext("child-run");
    addRun(now, parentKey, now);
    const parent = list().sessions[0];
    expect(parent?.childSessions).toEqual([childKey]);
    expect(parent?.hasActiveSubagentRun).toBe(false);
    expect(parent?.activeChildSessions).toEqual([]);
  });

  test("publishes live and settled parent activity through real lifecycle and transcript snapshots", async () => {
    await withStateDirEnv("openclaw-subagent-activity-push-", async ({ stateDir }) => {
      const now = Date.now();
      const liveStorePath = path.join(stateDir, "sessions.json");
      const liveCfg = { ...cfg, session: { store: liveStorePath } };
      setRuntimeConfigSnapshot(liveCfg, liveCfg);
      for (const [sessionKey, entry] of Object.entries(createStore(now))) {
        await replaceSessionEntry({ agentId: "main", sessionKey, storePath: liveStorePath }, entry);
      }
      addRun(now);
      registerAgentRunContext("child-run", { sessionKey: childKey });
      const broadcastToConnIds = vi.fn();
      const context = {
        broadcastToConnIds,
        sessionEventSubscribers: { getAll: () => new Set(["owner-connection"]) },
        sessionMessageSubscribers: { get: () => new Set<string>() },
        chatAbortControllers: new Map(),
      };
      const lifecycle = createLifecycleEventBroadcastHandler(context);
      const transcript = createTranscriptUpdateBroadcastHandler(context);
      const emitSnapshots = async (active: boolean) => {
        broadcastToConnIds.mockClear();
        lifecycle({ sessionKey: parentKey, reason: "child-updated" });
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({
            sessionKey: parentKey,
            hasActiveRun: false,
            hasActiveSubagentRun: active,
            activeChildSessions: active ? [childKey] : [],
          }),
          new Set(["owner-connection"]),
          { dropIfSlow: true },
        );
        await transcript({
          sessionKey: parentKey,
          message: { role: "assistant", content: [{ type: "text", text: "Parent update" }] },
          messageSeq: 1,
        });
        expect(broadcastToConnIds).toHaveBeenLastCalledWith(
          "session.message",
          expect.objectContaining({
            sessionKey: parentKey,
            hasActiveSubagentRun: active,
            activeChildSessions: active ? [childKey] : [],
            session: expect.objectContaining({
              key: parentKey,
              hasActiveSubagentRun: active,
              activeChildSessions: active ? [childKey] : [],
              status: "done",
            }),
          }),
          new Set(["owner-connection"]),
        );
      };
      await emitSnapshots(true);
      clearAgentRunContext("child-run");
      addRun(now, parentKey, now);
      await emitSnapshots(false);
    });
  });

  test("does not derive activity from an older live run when the latest run ended", () => {
    const now = Date.now();
    const store = createStore(now);
    addRun(now);
    registerAgentRunContext("child-run", { sessionKey: childKey });
    addSubagentRunForTests({
      runId: "replacement-run",
      childSessionKey: childKey,
      controllerSessionKey: parentKey,
      requesterSessionKey: parentKey,
      requesterDisplayKey: "parent",
      task: "replacement work",
      cleanup: "keep",
      createdAt: now - 200,
      startedAt: now - 150,
      endedAt: now - 100,
      outcome: { status: "ok" },
    });
    const parent = listSessionsFromStore({ cfg, storePath, store, opts: { limit: 1 } }).sessions[0];
    expect(parent?.childSessions).toEqual([childKey]);
    expect(parent?.hasActiveSubagentRun).toBe(false);
  });

  test.each([listSessionsFromStore, listSessionsFromStoreAsync])(
    "keeps filtered runtime children out of parent links and activity (%#)",
    async (list) => {
      const now = Date.now();
      const store = createStore(now);
      addRun(now);
      registerAgentRunContext("child-run", { sessionKey: childKey });
      const result = await list({
        cfg,
        storePath,
        store,
        opts: {},
        entryFilter: (key) => key !== childKey,
      });
      const parent = result.sessions.find((row) => row.key === parentKey);
      expect(parent?.childSessions).toBeUndefined();
      expect(parent?.hasActiveSubagentRun).not.toBe(true);
      expect(parent?.activeChildSessions).toEqual([]);
      expect(result.sessions.some((row) => row.key === childKey)).toBe(false);
    },
  );
});
