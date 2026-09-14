import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveDeletedAgentIdFromSessionKey } from "../../gateway/session-utils-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { readAcpSessionEntry, readAcpSessionMeta } from "../runtime/session-meta.js";
import { AcpSessionManager } from "./manager.js";
import { DEFAULT_DEPS } from "./manager.types.js";

describe("personal ACP durable lifecycle", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it.each(["persistent", "oneshot"] as const)(
    "preserves %s identity across a manager restart",
    async (mode) => {
      await withTempDir({ prefix: "personal-acp-lifecycle-" }, async (dir) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", dir);
        const sessionKey = "agent:person:acp:conversation";
        const cfg: OpenClawConfig = {
          agents: { entries: { person: {} } },
          acp: { enabled: true, backend: "test", allowedAgents: ["codex"] },
          session: { store: path.join(dir, "sessions.json") },
        };
        const entry = {
          sessionId: "conversation",
          lifecycleRevision: "revision",
          updatedAt: Date.now(),
          parentSessionKey: "agent:person:dashboard:parent",
        };
        await replaceSessionEntry({ sessionKey, storePath: cfg.session!.store! }, entry);
        const turns = new Map<string, string[]>();
        const ensureSession = vi.fn<AcpRuntime["ensureSession"]>(async (input) => {
          const id = input.resumeSessionId ?? randomUUID();
          if (!turns.has(id)) {
            turns.set(id, []);
          }
          return {
            sessionKey: input.sessionKey,
            backend: "test",
            runtimeSessionName: id,
            agentSessionId: id,
          };
        });
        const runtime: AcpRuntime = {
          ensureSession,
          async *runTurn(input) {
            const messages = turns.get(input.handle.agentSessionId!)!;
            messages.push(input.text);
            yield { type: "text_delta", text: messages.join("|") };
            yield { type: "done", stopReason: "end_turn" };
          },
          close: vi.fn(async () => {}),
          cancel: vi.fn(async () => {}),
        };
        const backend = { id: "test", runtime };
        const deps = {
          ...DEFAULT_DEPS,
          requireRuntimeBackend: () => backend,
          getRuntimeBackend: () => backend,
        };
        const manager = new AcpSessionManager(deps);
        await manager.initializeSession({
          cfg,
          sessionKey,
          agent: "codex",
          executionOwnerAgentId: "person",
          mode,
        });
        await manager.runTurn({
          cfg,
          sessionKey,
          text: "remember apple",
          mode: "prompt",
          provenance: "system",
          requestId: "first",
        });
        const persisted = readAcpSessionMeta({ cfg, sessionKey });
        expect(persisted).toMatchObject({
          agent: "codex",
          executionOwnerAgentId: "person",
          state: mode === "oneshot" ? "closed" : "idle",
        });
        const stored = readAcpSessionEntry({ cfg, sessionKey });
        expect(resolveDeletedAgentIdFromSessionKey(cfg, sessionKey, stored?.entry)).toBeNull();

        const restarted = new AcpSessionManager(deps);
        const second = () =>
          restarted.runTurn({
            cfg,
            sessionKey,
            text: "recall",
            mode: "prompt",
            provenance: "system",
            requestId: "second",
          });
        if (mode === "oneshot") {
          await expect(second()).rejects.toThrow("session is closed");
          expect((await restarted.getSessionStatus({ cfg, sessionKey })).state).toBe("closed");
          expect(ensureSession).toHaveBeenCalledTimes(1);
        } else {
          await second();
          expect(ensureSession).toHaveBeenLastCalledWith(
            expect.objectContaining({
              executionOwnerAgentId: "person",
              agent: "codex",
              resumeSessionId: persisted?.identity?.agentSessionId,
            }),
          );
          expect(turns.get(persisted!.identity!.agentSessionId!)).toEqual([
            "remember apple",
            "recall",
          ]);
          const staleCleanup = vi.fn(async () => {});
          await restarted.closeSession({
            cfg,
            sessionKey,
            reason: "test",
            retainClosedMeta: true,
            expectedLifecycleRevision: "old-revision",
            onRetired: staleCleanup,
          });
          expect(readAcpSessionMeta({ cfg, sessionKey })?.state).toBe("idle");
          expect(staleCleanup).not.toHaveBeenCalled();
          await expect(
            restarted.closeSession({
              cfg,
              sessionKey,
              reason: "test",
              retainClosedMeta: true,
              expectedLifecycleRevision: "revision",
              onRetired: async () => {
                throw new Error("route cleanup failed");
              },
            }),
          ).rejects.toThrow("route cleanup failed");
          expect(readAcpSessionMeta({ cfg, sessionKey })?.state).toBe("closed");

          // Current-conversation IDs are reused: the old close must finish
          // unbinding before a replacement initializes and rebinds the same ID.
          let binding = "same-conversation:old";
          const cleanupEntered = Promise.withResolvers<void>();
          const releaseCleanup = Promise.withResolvers<void>();
          const retirement = restarted.closeSession({
            cfg,
            sessionKey,
            reason: "retry-route-cleanup",
            retainClosedMeta: true,
            expectedLifecycleRevision: "revision",
            onRetired: async () => {
              cleanupEntered.resolve();
              await releaseCleanup.promise;
              binding = "";
            },
          });
          await cleanupEntered.promise;
          let replacementReady = false;
          const replacement = restarted
            .initializeSession({
              cfg,
              sessionKey,
              agent: "codex",
              executionOwnerAgentId: "person",
              mode: "persistent",
            })
            .then(() => {
              replacementReady = true;
              binding = "same-conversation:new";
            });
          await Promise.resolve();
          expect(replacementReady).toBe(false);
          releaseCleanup.resolve();
          await Promise.all([retirement, replacement]);
          expect(binding).toBe("same-conversation:new");
          expect(readAcpSessionMeta({ cfg, sessionKey })?.state).toBe("idle");
        }
      });
    },
  );
});
