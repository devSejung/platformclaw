import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  patchSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createDeferred } from "../test-utils/deferred.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { ensureClientVoiceAgentSessionEntry } from "./client-voice-session.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let tempDir: string;

describe("Talk session-entry creation admission", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-admission-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each(["active", "closed"])(
    "rechecks %s connection authority after the real SQLite writer queue drains",
    async (state) => {
      const blockerScope = { agentId: "main", sessionKey: "agent:main:talk:blocker" };
      await replaceSessionEntry(blockerScope, { sessionId: "blocker", updatedAt: 1 });
      const started = createDeferred();
      const release = createDeferred();
      // This is the accessor's asynchronous preparation phase, before BEGIN.
      const blocker = patchSessionEntry(blockerScope, async () => {
        started.resolve();
        await release.promise;
        return null;
      });
      await started.promise;
      const controller = new AbortController();
      const assertActive = vi.fn(() => controller.signal.throwIfAborted());
      const scope = { agentId: "main", sessionKey: `agent:main:talk:queued-${state}` };
      const creating = ensureClientVoiceAgentSessionEntry({ ...scope, assertActive });
      expect(assertActive).not.toHaveBeenCalled();
      if (state === "closed") {
        controller.abort(new Error("Talk connection closed"));
      }
      release.resolve();
      await blocker;

      if (state === "closed") {
        await expect(creating).rejects.toThrow("Talk connection closed");
        expect(loadSessionEntry(scope)).toBeUndefined();
      } else {
        const sessionId = await creating;
        expect(loadSessionEntry(scope)).toMatchObject({ sessionId, createdVia: "talk" });
        expect(assertActive).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("rechecks authority at commit after patch preparation yields", async () => {
    const controller = new AbortController();
    const scope = { agentId: "main", sessionKey: "agent:main:talk:commit-race" };
    const assertActive = vi.fn(() => {
      controller.signal.throwIfAborted();
      queueMicrotask(() => controller.abort(new Error("Talk connection closed before commit")));
    });

    await expect(ensureClientVoiceAgentSessionEntry({ ...scope, assertActive })).rejects.toThrow(
      "Talk connection closed before commit",
    );

    expect(assertActive).toHaveBeenCalledTimes(2);
    expect(loadSessionEntry(scope)).toBeUndefined();
  });
});
