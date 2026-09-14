import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { listSessionsFromStore } from "./session-utils.js";

const cfg = {
  agents: {
    defaults: { model: { primary: "openai/gpt-5.6-sol" } },
    list: [{ id: "main", default: true }],
  },
} as OpenClawConfig;

function closeSessionDatabases(): void {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

describe("sessions.list ACP runtime projection", () => {
  afterEach(() => {
    closeSessionDatabases();
  });

  test("uses persisted ACP metadata independent of session key shape", async () => {
    await withStateDirEnv("session-utils-acp-runtime-", async ({ stateDir }) => {
      try {
        const dashboardKey = "agent:main:dashboard:visible-acp";
        const acpKey = "agent:main:acp:11111111-1111-4111-8111-111111111111";
        const acpLookingWithoutMetadataKey = "agent:main:acp:22222222-2222-4222-8222-222222222222";
        const store: Record<string, SessionEntry> = {
          [dashboardKey]: { sessionId: "dashboard", updatedAt: 3 },
          [acpKey]: { sessionId: "acp", updatedAt: 2 },
          [acpLookingWithoutMetadataKey]: { sessionId: "plain", updatedAt: 1 },
        };
        const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");

        for (const [sessionKey, runtimeSessionName] of [
          [dashboardKey, "visible-acp-runtime"],
          [acpKey, "legacy-acp-runtime"],
        ] as const) {
          writeAcpSessionMetaForMigration({
            sessionKey,
            meta: {
              backend: "acpx",
              agent: "claude",
              runtimeSessionName,
              mode: "persistent",
              state: "idle",
              lastActivityAt: 1,
            },
          });
        }

        const listed = listSessionsFromStore({
          cfg,
          storePath,
          store,
          lightweightListRows: true,
          opts: {},
        });
        const byKey = new Map(listed.sessions.map((session) => [session.key, session]));

        expect(byKey.get(dashboardKey)?.agentRuntime).toEqual({
          id: "acpx",
          kind: "acp",
          agent: "claude",
          source: "session",
        });
        expect(byKey.get(acpKey)?.agentRuntime).toEqual({
          id: "acpx",
          kind: "acp",
          agent: "claude",
          source: "session-key",
        });
        expect(byKey.get(acpLookingWithoutMetadataKey)?.agentRuntime).toMatchObject({
          id: "codex",
          source: "implicit",
        });
        expect(byKey.get(acpLookingWithoutMetadataKey)?.agentRuntime).not.toHaveProperty("kind");
      } finally {
        closeSessionDatabases();
      }
    });
  });
});
