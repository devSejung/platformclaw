// Permanent session-purge Gateway boundary and legacy-owner admission coverage.
import fs from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { replaceSqliteTranscriptEvents } from "../config/sessions/session-accessor.sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test("sessions.delete purges transcript data without creating an archive and acknowledges a retry", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:purge-owned";
  const sessionId = "sess-purge-owned";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
    { type: "session", id: sessionId },
    {
      type: "message",
      id: "purge-message",
      parentId: null,
      message: { role: "user", content: "erase owned history" },
    },
  ]);
  const registry = getTestPluginRegistry();
  const priorCapabilities = registry.memoryCapabilities;
  // This fixture has no derived memory store; the real Gateway still exercises
  // the plugin fence and full native lifecycle before acknowledging its purge.
  registry.memoryCapabilities = [
    {
      pluginId: "test-memory",
      capability: {
        runtime: {
          getMemorySearchManager: async () => ({ manager: null }),
          resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
          withSessionPurge: async (_params, run) => await run(),
        },
      },
    },
  ];
  try {
    const result = await directSessionReq<{
      deleted: boolean;
      purged: boolean;
      archived: string[];
    }>("sessions.delete", { key: sessionKey, purgeTranscript: true });
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({ deleted: true, purged: true, archived: [] });
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(await loadTranscriptEvents({ sessionKey, sessionId, storePath })).toEqual([]);
    expect((await fs.readdir(dir)).filter((name) => name.startsWith(`${sessionId}.jsonl`))).toEqual(
      [],
    );
    const retry = await directSessionReq<{ deleted: boolean; purged: boolean }>("sessions.delete", {
      key: sessionKey,
      purgeTranscript: true,
    });
    expect(retry.payload).toMatchObject({ deleted: false, purged: true });
  } finally {
    registry.memoryCapabilities = priorCapabilities;
  }
});

test("sessions.delete accepts an absent fully qualified legacy Space owner without configured agent admission", async () => {
  const { storePath } = await createSessionStoreDir();
  const key =
    "agent:space-11111111-1111-4111-8111-111111111111:space:22222222-2222-4222-8222-222222222222";
  const result = await directSessionReq<{ key: string; deleted: boolean; purged: boolean }>(
    "sessions.delete",
    { key, purgeTranscript: true },
    {
      context: {
        getRuntimeConfig: () => ({ session: { store: storePath }, plugins: { enabled: false } }),
      },
    },
  );
  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({ key, deleted: false, purged: true });
});
