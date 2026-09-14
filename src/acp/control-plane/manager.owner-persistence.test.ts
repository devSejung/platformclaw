/** Integration coverage for manager ownership across the canonical SQLite boundary. */
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  upsertAcpSessionMeta,
} from "../runtime/session-meta.js";
import { AcpSessionManager } from "./manager.core.js";

const STABLE_AGENT_SESSION_ID = "claude-agent-session-owner-persistence";

describe("ACP manager execution owner persistence", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("reuses the isolated owner and persisted ACP resume id after SQLite reload", async () => {
    await withTempDir({ prefix: "openclaw-acp-owner-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const logicalAgentId = "claude-worker";
        const sessionKey = `agent:${logicalAgentId}:dashboard:owner-persistence`;
        const storePath = path.join(dir, "sessions.json");
        const cfg = {
          acp: { enabled: true, backend: "acpx" },
          session: { store: storePath },
        } as OpenClawConfig;
        await replaceSessionEntry(
          { agentId: logicalAgentId, storePath, sessionKey },
          {
            sessionId: "session-owner-persistence",
            lifecycleRevision: "revision-owner-persistence",
            sessionStartedAt: 1,
            updatedAt: 1,
          },
        );
        const createManager = () => {
          const ensureSession = vi.fn<AcpRuntime["ensureSession"]>(async (input) => ({
            sessionKey: input.sessionKey,
            backend: "acpx",
            runtimeSessionName: "claude-owner-persistence",
            agentSessionId: STABLE_AGENT_SESSION_ID,
          }));
          const runTurn = vi.fn<AcpRuntime["runTurn"]>(async function* () {
            yield { type: "done" as const };
          });
          const close = vi.fn<AcpRuntime["close"]>(async () => {});
          const cancel = vi.fn<AcpRuntime["cancel"]>(async () => {});
          const runtime: AcpRuntime = { ensureSession, runTurn, cancel, close };
          const backend = { id: "acpx", runtime };
          return {
            ensureSession,
            runTurn,
            close,
            manager: new AcpSessionManager({
              listAcpSessions: listAcpSessionEntries,
              loadSessionEntry: readAcpSessionEntry,
              upsertSessionMeta: upsertAcpSessionMeta,
              getRuntimeBackend: () => backend,
              requireRuntimeBackend: () => backend,
            }),
          };
        };
        const initial = createManager();

        await initial.manager.initializeSession({
          cfg,
          sessionKey,
          agent: "claude",
          executionOwnerAgentId: "person_one",
          mode: "persistent",
        });

        expect(
          openOpenClawStateDatabase()
            .db.prepare("SELECT execution_owner_agent_id FROM acp_sessions WHERE session_key = ?")
            .get(sessionKey),
        ).toEqual({ execution_owner_agent_id: "person_one" });
        expect(readAcpSessionEntry({ cfg, sessionKey })).toEqual(
          expect.objectContaining({
            acp: expect.objectContaining({
              agent: "claude",
              executionOwnerAgentId: "person_one",
              mode: "persistent",
              identity: expect.objectContaining({ agentSessionId: STABLE_AGENT_SESSION_ID }),
            }),
          }),
        );

        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        const reconnected = createManager();
        await reconnected.manager.runTurn({
          cfg,
          sessionKey,
          provenance: "agent",
          text: "Reply exactly ACP_OK",
          mode: "prompt",
          requestId: "request-owner-persistence",
        });

        expect(initial.ensureSession).toHaveBeenCalledTimes(1);
        expect(reconnected.ensureSession).toHaveBeenCalledTimes(1);
        expect(reconnected.ensureSession).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey,
            agent: "claude",
            executionOwnerAgentId: "person_one",
            resumeSessionId: STABLE_AGENT_SESSION_ID,
          }),
        );
        expect(reconnected.close).not.toHaveBeenCalled();
        expect(readAcpSessionEntry({ cfg, sessionKey })?.acp).toEqual(
          expect.objectContaining({
            agent: "claude",
            executionOwnerAgentId: "person_one",
            mode: "persistent",
            identity: expect.objectContaining({ agentSessionId: STABLE_AGENT_SESSION_ID }),
          }),
        );
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });
});
