import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { readAcpSessionMeta, upsertAcpSessionMeta } from "../runtime/session-meta.js";
import { testing as managerTesting } from "./manager.js";
import { closeAcpRuntimeForArchive } from "./session-lifecycle.js";

describe("ACP archive lifecycle", () => {
  afterEach(() => {
    managerTesting.resetAcpSessionManagerForTests();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("requests cache-only runtime retirement and preserves persisted resume metadata", async () => {
    await withTempDir({ prefix: "openclaw-acp-archive-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const agentId = "opencode-worker";
        const sessionKey = `agent:${agentId}:dashboard:archive-acp`;
        const storePath = path.join(dir, "sessions.json");
        const cfg = {
          acp: { enabled: true, backend: "acpx" },
          session: { store: storePath },
        } as OpenClawConfig;
        await replaceSessionEntry(
          { agentId, sessionKey, storePath },
          {
            sessionId: "archive-acp-session",
            lifecycleRevision: "archive-acp-revision",
            sessionStartedAt: 1,
            updatedAt: 1,
          },
        );
        await upsertAcpSessionMeta({
          cfg,
          sessionKey,
          mutate: () => ({
            backend: "acpx",
            agent: "opencode",
            executionOwnerAgentId: "main",
            runtimeSessionName: "opencode-persistent",
            identity: {
              state: "resolved",
              agentSessionId: "external-resume-id",
              source: "ensure",
              lastUpdatedAt: 2,
            },
            mode: "persistent",
            state: "idle",
            lastActivityAt: 2,
          }),
        });
        const closeSession = vi.fn(async () => ({
          runtimeClosed: true,
          metaCleared: false,
        }));
        managerTesting.setAcpSessionManagerForTests({ closeSession });

        await expect(closeAcpRuntimeForArchive({ cfg, sessionKey })).resolves.toBeNull();

        expect(closeSession).toHaveBeenCalledWith({
          cfg,
          sessionKey,
          reason: "session-archive",
          cacheOnly: true,
        });
        expect(readAcpSessionMeta({ cfg, sessionKey })).toEqual(
          expect.objectContaining({
            agent: "opencode",
            executionOwnerAgentId: "main",
            identity: expect.objectContaining({ agentSessionId: "external-resume-id" }),
            mode: "persistent",
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

  it("returns a visible archive error when warm cache retirement fails", async () => {
    await withTempDir({ prefix: "openclaw-acp-archive-error-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const agentId = "opencode-worker";
        const sessionKey = `agent:${agentId}:dashboard:archive-error`;
        const storePath = path.join(dir, "sessions.json");
        const cfg = { session: { store: storePath } } as OpenClawConfig;
        await replaceSessionEntry(
          { agentId, sessionKey, storePath },
          {
            sessionId: "archive-error-session",
            lifecycleRevision: "archive-error-revision",
            sessionStartedAt: 1,
            updatedAt: 1,
          },
        );
        await upsertAcpSessionMeta({
          cfg,
          sessionKey,
          mutate: () => ({
            backend: "acpx",
            agent: "opencode",
            runtimeSessionName: "opencode-persistent",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 2,
          }),
        });
        managerTesting.setAcpSessionManagerForTests({
          closeSession: vi.fn(async () => {
            throw new Error("warm close failed");
          }),
        });

        const error = await closeAcpRuntimeForArchive({ cfg, sessionKey });
        expect(error).toEqual(
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: expect.stringContaining("warm close failed"),
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
