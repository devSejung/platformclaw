import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasAcpSessionMetaExactLifecycle } from "../acp/runtime/session-meta.js";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  reconcileVisibleAcpPendingSessions,
  type VisibleAcpPendingReconcileResult,
} from "./visible-acp-pending-reconcile.js";
import { VISIBLE_ACP_INITIALIZATION_OWNER } from "./visible-acp-session-initialization.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function configForStore(storePath: string): OpenClawConfig {
  return {
    session: { store: storePath },
    agents: { list: [{ id: "claude-worker" }] },
  } as OpenClawConfig;
}

function persistedAcpMeta() {
  return {
    backend: "acpx",
    agent: "claude",
    runtimeSessionName: "claude-visible",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: 2,
  };
}

describe("visible ACP crash-orphan reconciliation", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("removes only the owned never-admitted visible ACP row and exact sidecar after restart", async () => {
    await withTempDir({ prefix: "openclaw-visible-acp-restart-reconcile-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const agentId = "claude-worker";
        const storePath = path.join(dir, "sessions.json");
        const cfg = configForStore(storePath);
        const visibleKey = `agent:${agentId}:dashboard:visible-pending`;
        const pluginKey = `agent:${agentId}:dashboard:plugin-pending`;
        await replaceSessionEntry({ agentId, sessionKey: visibleKey, storePath }, {
          sessionId: "visible-session",
          lifecycleRevision: "visible-revision",
          sessionStartedAt: 1,
          updatedAt: 1,
          initializationPending: true,
          initializationOwner: VISIBLE_ACP_INITIALIZATION_OWNER,
          agentHarnessId: "claude",
        } as never);
        await upsertAcpSessionMeta({
          cfg,
          sessionKey: visibleKey,
          mutate: () => persistedAcpMeta(),
        });
        await replaceSessionEntry(
          { agentId, sessionKey: pluginKey, storePath },
          {
            sessionId: "plugin-session",
            lifecycleRevision: "plugin-revision",
            sessionStartedAt: 1,
            updatedAt: 1,
            initializationPending: true,
            pluginOwnerId: "test-plugin",
          },
        );

        expect(
          hasAcpSessionMetaExactLifecycle({
            sessionKey: visibleKey,
            lifecycleRevision: "visible-revision",
          }),
        ).toBe(true);

        // Simulate the process boundary: reconciliation must work from durable state.
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();

        const result = await reconcileVisibleAcpPendingSessions({ cfg });
        expect(result).toEqual<VisibleAcpPendingReconcileResult>({
          checked: 1,
          removed: 1,
          skipped: 0,
        });
        expect(
          loadSessionEntryReadOnly({ agentId, sessionKey: visibleKey, storePath }),
        ).toBeUndefined();
        expect(
          hasAcpSessionMetaExactLifecycle({
            sessionKey: visibleKey,
            lifecycleRevision: "visible-revision",
          }),
        ).toBe(false);
        expect(loadSessionEntryReadOnly({ agentId, sessionKey: pluginKey, storePath })).toEqual(
          expect.objectContaining({
            sessionId: "plugin-session",
            initializationPending: true,
            pluginOwnerId: "test-plugin",
          }),
        );
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });

  it("does not delete a replacement row or replacement ACP sidecar", async () => {
    await withTempDir({ prefix: "openclaw-visible-acp-reconcile-race-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const agentId = "claude-worker";
        const storePath = path.join(dir, "sessions.json");
        const cfg = configForStore(storePath);
        const key = `agent:${agentId}:dashboard:race`;
        await replaceSessionEntry({ agentId, sessionKey: key, storePath }, {
          sessionId: "old-session",
          lifecycleRevision: "old-revision",
          sessionStartedAt: 1,
          updatedAt: 1,
          initializationPending: true,
          initializationOwner: VISIBLE_ACP_INITIALIZATION_OWNER,
          agentHarnessId: "claude",
        } as never);
        await upsertAcpSessionMeta({ cfg, sessionKey: key, mutate: () => persistedAcpMeta() });

        const lockEntered = deferred();
        const releaseLock = deferred();
        const holder = runExclusiveSessionLifecycleMutation({
          scope: storePath,
          identities: [key, "old-session"],
          run: async () => {
            lockEntered.resolve();
            await releaseLock.promise;
          },
        });
        await lockEntered.promise;

        const reconcilePromise = reconcileVisibleAcpPendingSessions({ cfg });
        await Promise.resolve();
        await replaceSessionEntry(
          { agentId, sessionKey: key, storePath },
          {
            sessionId: "replacement-session",
            lifecycleRevision: "replacement-revision",
            sessionStartedAt: 2,
            updatedAt: 2,
          },
        );
        await upsertAcpSessionMeta({ cfg, sessionKey: key, mutate: () => persistedAcpMeta() });
        releaseLock.resolve();
        await holder;
        const result = await reconcilePromise;

        expect(result.removed).toBe(0);
        expect(loadSessionEntryReadOnly({ agentId, sessionKey: key, storePath })).toEqual(
          expect.objectContaining({
            sessionId: "replacement-session",
            lifecycleRevision: "replacement-revision",
          }),
        );
        expect(
          hasAcpSessionMetaExactLifecycle({
            sessionKey: key,
            lifecycleRevision: "replacement-revision",
          }),
        ).toBe(true);
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });
});
