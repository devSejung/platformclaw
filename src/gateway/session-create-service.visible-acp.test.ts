import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, describe, expect, it } from "vitest";
import { testing as managerTesting } from "../acp/control-plane/manager.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { initializeVisibleAcpCreatedSession } from "./server-methods/visible-acp-session-create.js";
import { createGatewaySession } from "./session-create-service.js";
import {
  VISIBLE_ACP_INITIALIZATION_OWNER,
  VisibleAcpInitializationCleanupError,
} from "./visible-acp-session-initialization.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function configForStore(storePath: string): OpenClawConfig {
  return {
    session: { store: storePath },
    agents: { list: [{ id: "claude-worker" }] },
  } as OpenClawConfig;
}

describe("createGatewaySession trusted initializer lifecycle", () => {
  afterEach(() => {
    managerTesting.resetAcpSessionManagerForTests();
    unregisterAcpRuntimeBackend("visible-lifecycle-test");
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("creates the lifecycle before the real ACP initializer persists its binding", async () => {
    await withTempDir({ prefix: "openclaw-session-create-real-acp-init-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const agentId = "claude-worker";
        const runtimeAgentId = "claude";
        const storePath = path.join(dir, "sessions.json");
        const key = `agent:${agentId}:dashboard:real-init`;
        const cfg: OpenClawConfig = {
          acp: {
            enabled: true,
            backend: "visible-lifecycle-test",
            allowedAgents: [runtimeAgentId],
          },
          agents: {
            list: [
              {
                id: agentId,
                runtime: { type: "acp", acp: { agent: runtimeAgentId } },
              },
            ],
          },
          session: { store: storePath },
        };
        const ensureSessionCalls: Parameters<AcpRuntime["ensureSession"]>[] = [];
        const runtime: AcpRuntime = {
          ensureSession: async (input) => {
            ensureSessionCalls.push([input]);
            return {
              sessionKey: input.sessionKey,
              backend: "visible-lifecycle-test",
              runtimeSessionName: "claude-visible-session",
              agentSessionId: "claude-thread-id",
            };
          },
          async *runTurn() {
            yield { type: "done" };
          },
          cancel: async () => {},
          close: async () => {},
        };
        registerAcpRuntimeBackend({ id: "visible-lifecycle-test", runtime });

        const created = await createGatewaySession({
          cfg,
          key,
          agentId,
          commandSource: "test",
          initialEntry: {
            agentHarnessId: runtimeAgentId,
            initializationPending: true,
            initializationOwner: VISIBLE_ACP_INITIALIZATION_OWNER,
          },
          trustedInitializer: {
            owner: VISIBLE_ACP_INITIALIZATION_OWNER,
            initialize: async (lifecycle) =>
              await initializeVisibleAcpCreatedSession({
                cfg,
                agentId: lifecycle.agentId,
                sessionKey: lifecycle.key,
                storePath: lifecycle.storePath,
                entry: lifecycle.entry,
                intent: { logicalAgentId: agentId, runtimeAgentId },
              }),
          },
        });

        expect(created.ok).toBe(true);
        if (!created.ok) {
          throw new Error("expected connected visible ACP creation to succeed");
        }
        expect(created.entry.lifecycleRevision).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(ensureSessionCalls).toEqual([
          [expect.objectContaining({ sessionKey: key, agent: runtimeAgentId, mode: "persistent" })],
        ]);
        expect(readAcpSessionMeta({ cfg, sessionKey: key })).toEqual(
          expect.objectContaining({
            agent: runtimeAgentId,
            identity: expect.objectContaining({ agentSessionId: "claude-thread-id" }),
            mode: "persistent",
          }),
        );
        expect(created.entry.initializationPending).toBeUndefined();
        expect(created.entry.agentHarnessId).toBeUndefined();
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });

  it("keeps the trusted initializer inside the same lifecycle mutation", async () => {
    await withTempDir({ prefix: "openclaw-session-create-init-lock-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const storePath = path.join(dir, "sessions.json");
        const cfg = configForStore(storePath);
        const key = "agent:claude-worker:dashboard:lock-proof";
        const initializerEntered = deferred();
        const releaseInitializer = deferred();
        let competingEntered = false;

        const createPromise = createGatewaySession({
          cfg,
          key,
          agentId: "claude-worker",
          commandSource: "test",
          initialEntry: {
            agentHarnessId: "claude",
            initializationPending: true,
            initializationOwner: VISIBLE_ACP_INITIALIZATION_OWNER,
          },
          trustedInitializer: {
            owner: VISIBLE_ACP_INITIALIZATION_OWNER,
            initialize: async (created) => {
              initializerEntered.resolve();
              await releaseInitializer.promise;
              const updated = await updateSessionEntry(
                {
                  agentId: created.agentId,
                  sessionKey: created.key,
                  storePath: created.storePath,
                },
                (current) => {
                  if (
                    current?.sessionId !== created.entry.sessionId ||
                    current.lifecycleRevision !== created.entry.lifecycleRevision
                  ) {
                    return null;
                  }
                  const clearedFence: Partial<typeof current> & {
                    initializationOwner?: undefined;
                  } = {
                    initializationPending: undefined,
                    initializationOwner: undefined,
                    agentHarnessId: undefined,
                  };
                  return clearedFence;
                },
              );
              if (!updated) {
                throw new Error("test initializer lost its created lifecycle");
              }
              return updated;
            },
          },
        });

        await initializerEntered.promise;
        const competePromise = runExclusiveSessionLifecycleMutation({
          scope: storePath,
          identities: [key],
          run: async () => {
            competingEntered = true;
          },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(competingEntered).toBe(false);

        releaseInitializer.resolve();
        const created = await createPromise;
        expect(created.ok).toBe(true);
        if (!created.ok) {
          throw new Error("expected gateway session creation to succeed");
        }
        expect(created.entry.lifecycleRevision).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        await competePromise;
        expect(competingEntered).toBe(true);
        const stored = loadSessionEntryReadOnly({
          agentId: "claude-worker",
          sessionKey: key,
          storePath,
        });
        expect(stored?.initializationPending).toBeUndefined();
        expect(stored?.agentHarnessId).toBeUndefined();
        expect(
          (stored as { initializationOwner?: string } | undefined)?.initializationOwner,
        ).toBeUndefined();
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });

  it("never deletes a replacement lifecycle when trusted initialization fails", async () => {
    await withTempDir({ prefix: "openclaw-session-create-exact-rollback-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const storePath = path.join(dir, "sessions.json");
        const cfg = configForStore(storePath);
        const key = "agent:claude-worker:dashboard:replacement-proof";
        const replacement = {
          sessionId: "replacement-session",
          lifecycleRevision: "replacement-revision",
          sessionStartedAt: 10,
          updatedAt: 10,
        };

        await expect(
          createGatewaySession({
            cfg,
            key,
            agentId: "claude-worker",
            commandSource: "test",
            initialEntry: {
              agentHarnessId: "claude",
              initializationPending: true,
              initializationOwner: VISIBLE_ACP_INITIALIZATION_OWNER,
            },
            trustedInitializer: {
              owner: VISIBLE_ACP_INITIALIZATION_OWNER,
              initialize: async (created) => {
                await replaceSessionEntry(
                  {
                    agentId: created.agentId,
                    sessionKey: created.key,
                    storePath: created.storePath,
                  },
                  replacement,
                );
                throw new Error("initializer failed after lifecycle replacement");
              },
            },
          }),
        ).rejects.toThrow("exact lifecycle rollback did not delete");

        expect(
          loadSessionEntryReadOnly({ agentId: "claude-worker", sessionKey: key, storePath }),
        ).toEqual(expect.objectContaining(replacement));
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });

  it("preserves the pending recovery anchor when exact runtime cleanup cannot be confirmed", async () => {
    await withTempDir({ prefix: "openclaw-session-create-cleanup-fail-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      try {
        const storePath = path.join(dir, "sessions.json");
        const cfg = configForStore(storePath);
        const key = "agent:claude-worker:dashboard:cleanup-fail";

        await expect(
          createGatewaySession({
            cfg,
            key,
            agentId: "claude-worker",
            commandSource: "test",
            initialEntry: {
              agentHarnessId: "claude",
              initializationPending: true,
              initializationOwner: VISIBLE_ACP_INITIALIZATION_OWNER,
            },
            trustedInitializer: {
              owner: VISIBLE_ACP_INITIALIZATION_OWNER,
              initialize: async () => {
                throw new VisibleAcpInitializationCleanupError(
                  new Error("initialization failed"),
                  new Error("runtime close failed"),
                );
              },
            },
          }),
        ).rejects.toBeInstanceOf(VisibleAcpInitializationCleanupError);

        expect(
          loadSessionEntryReadOnly({ agentId: "claude-worker", sessionKey: key, storePath }),
        ).toEqual(
          expect.objectContaining({
            initializationPending: true,
            agentHarnessId: "claude",
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
