import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as managerTesting } from "../../acp/control-plane/manager.js";
import { readAcpSessionMeta, upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { VISIBLE_ACP_INITIALIZATION_OWNER } from "../visible-acp-session-initialization.js";
import { initializeVisibleAcpCreatedSession } from "./visible-acp-session-create.js";

function visibleAcpConfig(params: {
  storePath: string;
  logicalAgentId: string;
  runtimeAgentId: string;
  enabled?: boolean;
  mappedRuntimeAgentId?: string;
  allowedRuntimeAgentIds?: string[];
  includeLogicalAgent?: boolean;
  omitMappedRuntimeAgent?: boolean;
  agentBackend?: string;
  agentCwd?: string;
}): OpenClawConfig {
  return {
    acp: {
      enabled: params.enabled ?? true,
      backend: "acpx",
      allowedAgents: params.allowedRuntimeAgentIds ?? [params.runtimeAgentId],
    },
    agents: {
      list:
        params.includeLogicalAgent === false
          ? [{ id: "main" }]
          : [
              {
                id: params.logicalAgentId,
                runtime: {
                  type: "acp",
                  acp: {
                    ...(params.omitMappedRuntimeAgent
                      ? {}
                      : { agent: params.mappedRuntimeAgentId ?? params.runtimeAgentId }),
                    ...(params.agentBackend ? { backend: params.agentBackend } : {}),
                    ...(params.agentCwd ? { cwd: params.agentCwd } : {}),
                  },
                },
              },
            ],
    },
    session: { store: params.storePath },
  } as OpenClawConfig;
}

function pendingEntry(runtimeAgentId: string, cwd?: string) {
  return {
    sessionId: "visible-acp-session",
    lifecycleRevision: "visible-acp-revision",
    sessionStartedAt: 1,
    updatedAt: 1,
    initializationPending: true as const,
    initializationOwner: VISIBLE_ACP_INITIALIZATION_OWNER,
    agentHarnessId: runtimeAgentId,
    ...(cwd ? { spawnedCwd: cwd } : {}),
  };
}

describe("visible ACP trusted initializer", () => {
  afterEach(() => {
    managerTesting.resetAcpSessionManagerForTests();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("persists the trusted harness/owner before clearing the owned creation fence", async () => {
    await withTempDir({ prefix: "openclaw-visible-acp-init-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const agentId = "claude-worker";
        const runtimeAgentId = "claude";
        const sessionKey = `agent:${agentId}:dashboard:visible-acp`;
        const storePath = path.join(dir, "sessions.json");
        const cfg = visibleAcpConfig({ storePath, logicalAgentId: agentId, runtimeAgentId });
        const entry = pendingEntry(runtimeAgentId, dir);
        await replaceSessionEntry({ agentId, sessionKey, storePath }, entry);

        const handle = {
          sessionKey,
          backend: "acpx",
          runtimeSessionName: "claude-visible-acp",
          agentSessionId: "claude-agent-session",
        };
        const initializeSession = vi.fn(async () => {
          await upsertAcpSessionMeta({
            cfg,
            sessionKey,
            mutate: () => ({
              backend: "acpx",
              agent: runtimeAgentId,
              executionOwnerAgentId: "main",
              runtimeSessionName: handle.runtimeSessionName,
              mode: "persistent",
              state: "idle",
              lastActivityAt: 2,
            }),
          });
          return { handle };
        });
        const closeSession = vi.fn();
        managerTesting.setAcpSessionManagerForTests({ initializeSession, closeSession });

        const initialized = await initializeVisibleAcpCreatedSession({
          cfg,
          agentId,
          sessionKey,
          storePath,
          entry,
          intent: {
            logicalAgentId: agentId,
            runtimeAgentId,
            executionOwnerAgentId: "main",
          },
        });

        expect(initializeSession).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey,
            agent: runtimeAgentId,
            executionOwnerAgentId: "main",
            mode: "persistent",
            cwd: dir,
          }),
        );
        expect(initialized.initializationPending).toBeUndefined();
        expect(
          (initialized as { initializationOwner?: string }).initializationOwner,
        ).toBeUndefined();
        expect(initialized.agentHarnessId).toBeUndefined();
        const stored = loadSessionEntryReadOnly({ agentId, sessionKey, storePath });
        expect(stored?.initializationPending).toBeUndefined();
        expect(
          (stored as { initializationOwner?: string } | undefined)?.initializationOwner,
        ).toBeUndefined();
        expect(readAcpSessionMeta({ cfg, sessionKey })).toEqual(
          expect.objectContaining({
            agent: runtimeAgentId,
            executionOwnerAgentId: "main",
            mode: "persistent",
          }),
        );
        expect(closeSession).not.toHaveBeenCalled();
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });

  it("uses the logical agent fallback and current per-agent backend/cwd defaults", async () => {
    await withTempDir({ prefix: "openclaw-visible-acp-agent-defaults-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const agentId = "claude";
        const sessionKey = `agent:${agentId}:dashboard:defaults`;
        const storePath = path.join(dir, "sessions.json");
        const configuredCwd = path.join(dir, "configured-cwd");
        const cfg = visibleAcpConfig({
          storePath,
          logicalAgentId: agentId,
          runtimeAgentId: agentId,
          omitMappedRuntimeAgent: true,
          agentBackend: "agent-acpx",
          agentCwd: configuredCwd,
        });
        const entry = pendingEntry(agentId);
        await replaceSessionEntry({ agentId, sessionKey, storePath }, entry);
        const handle = {
          sessionKey,
          backend: "agent-acpx",
          runtimeSessionName: "claude-defaults",
        };
        const initializeSession = vi.fn(async () => {
          await upsertAcpSessionMeta({
            cfg,
            sessionKey,
            mutate: () => ({
              backend: "agent-acpx",
              agent: agentId,
              runtimeSessionName: handle.runtimeSessionName,
              mode: "persistent",
              cwd: configuredCwd,
              state: "idle",
              lastActivityAt: 2,
            }),
          });
          return { handle };
        });
        managerTesting.setAcpSessionManagerForTests({ initializeSession, closeSession: vi.fn() });

        await initializeVisibleAcpCreatedSession({
          cfg,
          agentId,
          sessionKey,
          storePath,
          entry,
          intent: {
            logicalAgentId: agentId,
            runtimeAgentId: agentId,
            cwd: path.join(dir, "inherited-cwd"),
            cwdExplicit: false,
          },
        });

        expect(initializeSession).toHaveBeenCalledWith(
          expect.objectContaining({
            agent: agentId,
            backendId: "agent-acpx",
            cwd: configuredCwd,
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

  it.each([
    [
      "disabled",
      (storePath: string) =>
        visibleAcpConfig({
          storePath,
          logicalAgentId: "claude-worker",
          runtimeAgentId: "claude",
          enabled: false,
        }),
    ],
    [
      "removed",
      (storePath: string) =>
        visibleAcpConfig({
          storePath,
          logicalAgentId: "claude-worker",
          runtimeAgentId: "claude",
          includeLogicalAgent: false,
        }),
    ],
    [
      "remapped",
      (storePath: string) =>
        visibleAcpConfig({
          storePath,
          logicalAgentId: "claude-worker",
          runtimeAgentId: "claude",
          mappedRuntimeAgentId: "codex",
        }),
    ],
    [
      "disallowed",
      (storePath: string) =>
        visibleAcpConfig({
          storePath,
          logicalAgentId: "claude-worker",
          runtimeAgentId: "claude",
          allowedRuntimeAgentIds: ["codex"],
        }),
    ],
  ])("rejects stale trusted intent after ACP config is %s", async (_name, makeCfg) => {
    await withTempDir({ prefix: "openclaw-visible-acp-current-config-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const agentId = "claude-worker";
        const runtimeAgentId = "claude";
        const sessionKey = `agent:${agentId}:dashboard:stale-config`;
        const storePath = path.join(dir, "sessions.json");
        const entry = pendingEntry(runtimeAgentId);
        await replaceSessionEntry({ agentId, sessionKey, storePath }, entry);
        const initializeSession = vi.fn();
        managerTesting.setAcpSessionManagerForTests({ initializeSession, closeSession: vi.fn() });

        await expect(
          initializeVisibleAcpCreatedSession({
            cfg: makeCfg(storePath),
            agentId,
            sessionKey,
            storePath,
            entry,
            intent: { logicalAgentId: agentId, runtimeAgentId },
          }),
        ).rejects.toThrow();

        expect(initializeSession).not.toHaveBeenCalled();
        expect(
          loadSessionEntryReadOnly({ agentId, sessionKey, storePath })?.initializationPending,
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

  it("retires only the exact initialized handle when durable metadata verification fails", async () => {
    await withTempDir({ prefix: "openclaw-visible-acp-init-fail-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const agentId = "codex-worker";
        const runtimeAgentId = "codex";
        const sessionKey = `agent:${agentId}:dashboard:visible-acp-fail`;
        const storePath = path.join(dir, "sessions.json");
        const cfg = visibleAcpConfig({ storePath, logicalAgentId: agentId, runtimeAgentId });
        const entry = pendingEntry(runtimeAgentId);
        await replaceSessionEntry({ agentId, sessionKey, storePath }, entry);
        const handle = {
          sessionKey,
          backend: "acpx",
          runtimeSessionName: "codex-visible-acp",
          agentSessionId: "codex-agent-session",
        };
        const closeSession = vi.fn(async () => ({ runtimeClosed: true, metaCleared: false }));
        managerTesting.setAcpSessionManagerForTests({
          initializeSession: vi.fn(async () => ({ handle })),
          closeSession,
        });

        await expect(
          initializeVisibleAcpCreatedSession({
            cfg,
            agentId,
            sessionKey,
            storePath,
            entry,
            intent: { logicalAgentId: agentId, runtimeAgentId },
          }),
        ).rejects.toThrow("did not persist the trusted runtime identity");

        expect(closeSession).toHaveBeenCalledWith({
          cfg,
          sessionKey,
          reason: "visible-acp-init-failed",
          cacheOnly: true,
          expectedHandle: handle,
          discardPersistentState: true,
        });
        expect(loadSessionEntryReadOnly({ agentId, sessionKey, storePath })).toEqual(
          expect.objectContaining({
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            initializationPending: true,
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
});
