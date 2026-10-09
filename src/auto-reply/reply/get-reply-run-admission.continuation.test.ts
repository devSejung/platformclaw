import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createDeferred } from "../../test-utils/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { DispatchSessionRefreshRequiredError } from "./dispatch-session-refresh-error.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import type { PreparedReplyRunContext } from "./get-reply-run-context.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";

vi.mock("./get-reply-run-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./get-reply-run-helpers.js")>();
  return {
    ...actual,
    loadAgentRunnerRuntime: async () => ({ runReplyAgent: vi.fn() }),
  };
});

afterEach(() => testing.resetReplyRunRegistry());

describe("native command continuation session adoption", () => {
  it.each(["compaction", "active", "replacement", "abort"] as const)(
    "consumes the authoritative target entry after preparation: %s",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath = state.statePath("sessions.json");
        const targetKey = "agent:main:telegram:group:target";
        const sourceKey = "agent:main:telegram:slash:employee";
        const original = { sessionId: "target-original", updatedAt: Date.now() };
        await replaceSessionEntry({ sessionKey: targetKey, storePath }, original);
        const target = await admitReplyTurn({
          sessionKey: targetKey,
          sessionId: original.sessionId,
          storePath,
          kind: "visible",
          resetTriggered: false,
        });
        if (target.status !== "owned") {
          throw new Error("fixture requires an admitted target owner");
        }
        const source = replyRunRegistry.begin({
          sessionKey: sourceKey,
          sessionId: "slash-reservation",
          resetTriggered: false,
        });
        const sessionStore = { [targetKey]: original };
        const handle = createReplySessionEntryHandle({
          sessionEntry: original,
          sessionKey: targetKey,
          sessionStore,
          generationFence: { sessionId: original.sessionId, expectedStoreEntry: original },
        });
        const thinking = createDeferred<"off">();
        const resolveDefaultThinkingLevel = vi.fn(() => thinking.promise);
        const controller = new AbortController();
        const onSessionPrepared = vi.fn();
        const ctx = finalizeInboundContext({
          Body: "Continue the original command",
          Provider: "telegram",
          SessionKey: sourceKey,
          CommandSource: "native",
          CommandAuthorized: true,
          CommandTargetSessionKey: targetKey,
          SenderId: "original-employee",
        });
        const context = {
          params: {
            ctx,
            sessionCtx: ctx,
            cfg: {},
            agentId: "main",
            agentDir: state.agentDir(),
            directives: { hasThinkDirective: false },
            modelState: { resolveDefaultThinkingLevel },
            provider: "openai",
            model: "gpt-4o",
            typing: { cleanup: vi.fn() },
            opts: { replyOperation: source, abortSignal: controller.signal, onSessionPrepared },
            isNewSession: false,
            sessionKey: targetKey,
            sessionId: original.sessionId,
            storePath,
            sessionEntryHandle: handle,
            sessionStore,
          },
          traceRunPhase: async (_phase: string, run: () => Promise<unknown>) => await run(),
          inboundEventKind: "user_request",
          useFastReplyRuntime: true,
          isFirstTurnInSession: false,
          baseBodyFinal: ctx.Body,
          prefixedBodyBase: ctx.Body,
          hasUserBody: true,
          isBareSessionReset: false,
          startupAction: "new",
          workspaceDir: state.workspaceDir,
          heartbeatRunScope: "full",
          effectiveResetTriggered: false,
          sessionEntry: original,
          getInboundContext: () => ({ inboundUserContext: "" }),
          getSessionEntry: () => handle.getCurrent(),
          refreshInboundContextAfterAdmissionWait: async () => {},
        } as unknown as PreparedReplyRunContext;
        const pending = prepareReplyRunAdmission(context);
        try {
          await vi.waitFor(() => expect(resolveDefaultThinkingLevel).toHaveBeenCalledOnce());
          await replaceSessionEntry(
            { sessionKey: targetKey, storePath },
            { sessionId: "target-compacted", updatedAt: Date.now(), label: "Current target" },
          );
          if (scenario === "compaction" || scenario === "active") {
            target.operation.updateSessionId("target-compacted");
          }
          if (scenario !== "active") {
            target.operation.complete();
          }
          if (scenario === "abort") {
            controller.abort();
          }
          thinking.resolve("off");
          if (scenario === "replacement") {
            await expect(pending).rejects.toBeInstanceOf(DispatchSessionRefreshRequiredError);
          } else {
            const prepared = await pending;
            if (scenario === "abort") {
              expect(prepared).toEqual({ kind: "reply", reply: undefined });
              expect(source.key).toBe(sourceKey);
            } else {
              expect(prepared.kind).toBe("ready");
              if (prepared.kind !== "ready") {
                throw new Error("compaction continuation must prepare an agent run");
              }
              const current = loadSessionEntry({ sessionKey: targetKey, storePath });
              expect(source.key).toBe(scenario === "active" ? sourceKey : targetKey);
              expect(source.sessionId).toBe(
                scenario === "active" ? "slash-reservation" : "target-compacted",
              );
              expect(prepared.sessionIdFinal).toBe("target-compacted");
              expect(prepared.preparedSessionState).toMatchObject({
                sessionId: "target-compacted",
                sessionEntry: current,
              });
              expect(prepared.sessionEntry).toEqual(current);
              expect(handle.getCurrent()).toEqual(current);
              expect(sessionStore[targetKey]).toEqual(current);
              expect(onSessionPrepared).toHaveBeenLastCalledWith({
                sessionKey: targetKey,
                sessionId: "target-compacted",
                storePath,
              });
              expect(ctx.SenderId).toBe("original-employee");
            }
          }
        } finally {
          thinking.resolve("off");
          target.operation.complete();
          source.complete();
          await pending.catch(() => undefined);
        }
      });
    },
  );
});
