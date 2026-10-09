import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureSessionDatabaseIdentity,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDispatchReplyOperationCoordinator } from "./dispatch-from-config.lifecycle.js";
import { DispatchSessionRefreshRequiredError } from "./dispatch-session-refresh-error.js";
import { finalizeInboundContext } from "./inbound-context.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import {
  captureReplyRunAdmissionSource,
  type ReplyOperation,
  replyRunRegistry,
  runAfterReplyOperationClear,
} from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { initSessionState } from "./session.js";

const sessionKey = "agent:main:compaction-continuation";
const initialSessionId = "before-compaction";
const compactedSessionId = "after-compaction";

async function own(storePath: string, sessionId = initialSessionId) {
  const admission = await admitReplyTurn({
    sessionKey,
    sessionId,
    storePath,
    kind: "visible",
    resetTriggered: false,
  });
  if (admission.status !== "owned") {
    throw new Error("fixture requires a real store-owned operation");
  }
  return admission.operation;
}

async function seed(storePath: string, sessionId = initialSessionId) {
  await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
}

async function rotate(
  operation: ReplyOperation,
  storePath: string,
  sessionId = compactedSessionId,
) {
  await seed(storePath, sessionId);
  operation.updateSessionId(sessionId);
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dispatcher(): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    waitForIdle: async () => {},
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {},
  };
}

afterEach(() => testing.resetReplyRunRegistry());

describe("owned compaction continuation", () => {
  it.each(["lane", "store"] as const)(
    "does not carry source UUID lineage across target %s adoption",
    async (boundary) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const sourceStore = state.statePath("sessions.json");
        const targetStore = boundary === "store" ? state.statePath("target.sqlite") : sourceStore;
        const targetKey = boundary === "lane" ? "agent:main:target-lane" : sessionKey;
        await seed(sourceStore);
        const operation = await own(sourceStore);
        await rotate(operation, sourceStore, "source-compacted");
        await replaceSessionEntry(
          { sessionKey: targetKey, storePath: targetStore },
          { sessionId: "target-current", updatedAt: Date.now() },
        );
        const adopted = await admitReplyTurn({
          sessionKey: targetKey,
          sessionId: operation.sessionId,
          expectedSessionId: "target-current",
          storePath: targetStore,
          adoptOperation: operation,
          kind: "visible",
          resetTriggered: false,
        });
        expect(adopted.status).toBe("owned");
        await replaceSessionEntry(
          { sessionKey: targetKey, storePath: targetStore },
          { sessionId: "target-compacted", updatedAt: Date.now() },
        );
        operation.updateSessionId("target-compacted");
        expect(operation.hasOwnedSessionId(initialSessionId)).toBe(true);
        expect(captureReplyRunAdmissionSource(operation).sessionIds).toEqual(
          new Set(["target-current", "target-compacted"]),
        );
        operation.complete();
        await expect(
          admitReplyTurn({
            sessionKey: targetKey,
            sessionId: initialSessionId,
            expectedSessionId: initialSessionId,
            expectedActiveOperations: [operation],
            storePath: targetStore,
            kind: "visible",
            resetTriggered: false,
          }),
        ).rejects.toBeInstanceOf(DispatchSessionRefreshRequiredError);
      });
    },
  );

  it("keeps earlier after-clear cleanup in its store when a foreign visible owner rotates", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("sessions.json");
      const foreignStore = state.statePath("foreign.sqlite");
      await seed(storePath);
      await seed(foreignStore, "foreign-current");
      const first = await own(storePath);
      const delivery = deferred();
      const afterClear = vi.fn();
      runAfterReplyOperationClear(first, afterClear);
      first.completeWithAfterClearBarrier(delivery.promise);
      const foreign = await own(foreignStore, "foreign-current");
      await rotate(foreign, foreignStore, "foreign-compacted");
      foreign.complete();
      delivery.resolve();
      await vi.waitFor(() => expect(afterClear).toHaveBeenCalledWith(initialSessionId));
    });
  });

  it.each(["completed", "active", "successive"] as const)(
    "carries the admitted identity through dispatch and real session initialization: %s",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath = state.statePath("sessions.json");
        const cfg = { session: { store: storePath } };
        await seed(storePath);
        const predecessor = await own(storePath);
        await rotate(predecessor, storePath);
        let successor: ReplyOperation | undefined;
        if (scenario !== "active") {
          predecessor.complete();
        }
        if (scenario === "successive") {
          successor = await own(storePath, compactedSessionId);
        }
        const ctx = finalizeInboundContext({
          Body: "Original accepted message",
          SessionKey: sessionKey,
          Provider: "webchat",
          Surface: "webchat",
          SenderId: "original-employee",
          SenderName: "Original employee",
        });
        const coordinator = createDispatchReplyOperationCoordinator({
          ctx,
          dispatcher: dispatcher(),
          dispatchOperationSessionKey: sessionKey,
          initialDispatchReplyOperation: successor,
          operationSessionStoreEntry: {
            storePath,
            entry: { sessionId: initialSessionId, updatedAt: 1 },
          },
          replyOptions: {
            runId: "original-send-id",
            expectedExistingSessionId: initialSessionId,
            expectedActiveReplyOperation: predecessor,
          },
          resolvePreparedOperationSessionId: () => undefined,
        });
        let expected = compactedSessionId;
        if (successor) {
          expected = "after-second-compaction";
          await rotate(successor, storePath, expected);
          successor.complete();
        }
        try {
          expect(await coordinator.ensureDispatchReplyOperation("pre_dispatch")).toEqual({
            status: "ready",
          });
          if (scenario === "active") {
            // Compaction can also finish while pre-dispatch hooks hold their lease.
            predecessor.complete();
          }
          expect(await coordinator.ensureDispatchReplyOperation("dispatch")).toEqual({
            status: "ready",
          });
          const options = coordinator.getReplyOptions();
          expect(options).toMatchObject({
            runId: "original-send-id",
            expectedExistingSessionId: expected,
          });
          const initialized = await initSessionState({
            ctx,
            cfg,
            commandAuthorized: true,
            expectedExistingSessionId: options?.expectedExistingSessionId,
            signal: options?.abortSignal,
          });
          expect(initialized.sessionId).toBe(expected);
          expect(ctx).toMatchObject({
            SenderId: "original-employee",
            SenderName: "Original employee",
            BodyForAgent: "Original accepted message",
          });
          expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(expected);
        } finally {
          predecessor.complete();
          successor?.complete();
          coordinator.completeDispatchReplyOperation();
          await coordinator.releasePreDispatchLifecycleAdmission();
        }
      });
    },
  );

  it.each(["foreign-store", "replacement", "restart", "reopened", "rekeyed"] as const)(
    "rejects a changed target without valid owner evidence: %s",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath = state.statePath("sessions.json");
        const predecessorStore =
          scenario === "foreign-store" ? state.statePath("foreign.sqlite") : storePath;
        await seed(storePath);
        await seed(predecessorStore);
        const predecessor = await own(predecessorStore);
        await seed(storePath, compactedSessionId);
        if (scenario !== "replacement") {
          await rotate(predecessor, predecessorStore);
        }
        if (scenario === "restart") {
          predecessor.abortForRestart();
        }
        if (scenario === "rekeyed") {
          predecessor.updateSessionKey("agent:main:other-lane");
        }
        predecessor.complete();
        if (scenario === "reopened") {
          closeOpenClawAgentDatabaseByPath(
            path.join(path.dirname(storePath), "openclaw-agent.sqlite"),
          );
        }
        await expect(
          admitReplyTurn({
            sessionKey,
            sessionId: initialSessionId,
            expectedSessionId: initialSessionId,
            expectedActiveOperations: [predecessor],
            storePath,
            kind: "visible",
            resetTriggered: false,
          }),
        ).rejects.toBeInstanceOf(DispatchSessionRefreshRequiredError);
        expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      });
    },
  );

  it("keeps an accepted cancelled continuation from acquiring the compacted lane", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("sessions.json");
      await seed(storePath);
      const predecessor = await own(storePath);
      await rotate(predecessor, storePath);
      predecessor.complete();
      const controller = new AbortController();
      controller.abort();
      expect(
        await admitReplyTurn({
          sessionKey,
          sessionId: initialSessionId,
          expectedSessionId: initialSessionId,
          expectedActiveOperations: [predecessor],
          storePath,
          upstreamAbortSignal: controller.signal,
          kind: "visible",
          resetTriggered: false,
        }),
      ).toEqual({ status: "skipped", reason: "aborted" });
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
    });
  });

  it("joins connected compactions while queued work waits behind overlapping delivery barriers", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("sessions.json");
      await seed(storePath);
      const first = await own(storePath);
      const firstDelivery = deferred();
      const secondDelivery = deferred();
      await rotate(first, storePath);
      first.completeWithAfterClearBarrier(firstDelivery.promise);
      const second = await own(storePath, compactedSessionId);
      await rotate(second, storePath, "after-second-compaction");
      second.completeWithAfterClearBarrier(secondDelivery.promise);
      const pending = admitReplyTurn({
        sessionKey,
        sessionId: initialSessionId,
        expectedSessionId: initialSessionId,
        storePath,
        kind: "queued_followup",
        resetTriggered: false,
      });
      firstDelivery.resolve();
      secondDelivery.resolve();
      const admission = await pending;
      expect(admission.status).toBe("owned");
      if (admission.status === "owned") {
        expect(admission.operation.sessionId).toBe("after-second-compaction");
        admission.operation.complete();
      }
    });
  });

  it("uses one canonical owner for logical JSON, SQLite and lexical aliases, with new identity after reopen", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("sessions.json");
      await seed(storePath);
      const sqlitePath = state.statePath("openclaw-agent.sqlite");
      const logical = captureSessionDatabaseIdentity({ sessionKey, storePath });
      const exact = captureSessionDatabaseIdentity({ sessionKey, storePath: sqlitePath });
      const alias = captureSessionDatabaseIdentity({
        sessionKey,
        storePath: path.join(path.dirname(storePath), ".", "sessions.json"),
      });
      expect(exact.identity).toBe(logical.identity);
      expect(alias.identity).toBe(logical.identity);
      expect(logical.isCurrent()).toBe(true);
      closeOpenClawAgentDatabaseByPath(sqlitePath);
      expect(logical.isCurrent()).toBe(false);
      const reopened = captureSessionDatabaseIdentity({ sessionKey, storePath });
      expect(reopened.identity === logical.identity).toBe(false);
      expect(reopened.isCurrent()).toBe(true);
    });
  });
});
