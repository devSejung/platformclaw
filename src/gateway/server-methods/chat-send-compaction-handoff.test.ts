import { afterEach, describe, expect, it, vi } from "vitest";
import * as dispatch from "../../auto-reply/dispatch.js";
import type { InternalGetReplyFromConfig } from "../../auto-reply/reply/get-reply.types.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { resetInboundDedupe } from "../../auto-reply/reply/inbound-dedupe.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import { testing } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  admitReplyTurn,
  runWithReplyOperationLifecycleAdmission,
} from "../../auto-reply/reply/reply-turn-admission.js";
import { initSessionState } from "../../auto-reply/reply/session.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createDeferred } from "../../test-utils/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

const sessionKey = "agent:main:compaction-attachment";
const originalSessionId = "attachment-before-compaction";
const nextSessionId = "attachment-after-compaction";
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

afterEach(() => {
  vi.restoreAllMocks();
  resetInboundDedupe();
  testing.resetReplyRunRegistry();
});

describe("chat.send compaction while attachments prepare", () => {
  it.each(["compaction", "replacement", "reset"] as const)(
    "keeps the original accepted turn and cancellation owner across %s",
    async (scenario) => {
      // Inbound dedupe spans session stores; each accepted request needs its own
      // identity so an earlier successful scenario cannot suppress this one.
      const runId = `original-attachment-request-${scenario}`;
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath = state.statePath("sessions.json");
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: "test-provider/vision-model" },
            },
          },
          session: { store: storePath },
          plugins: { enabled: false },
        };
        await state.writeConfig(cfg);
        const seed = async (sessionId: string) =>
          await replaceSessionEntry(
            { sessionKey, storePath },
            {
              sessionId,
              updatedAt: Date.now(),
              modelProvider: "test-provider",
              model: "vision-model",
              label: "Attachment continuation",
            },
          );
        await seed(originalSessionId);
        const owner = await admitReplyTurn({
          sessionKey,
          sessionId: originalSessionId,
          storePath,
          kind: "visible",
          resetTriggered: false,
        });
        if (owner.status !== "owned") {
          throw new Error("fixture requires a real SQLite-owned predecessor");
        }
        const snapshot = {
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          config: cfg,
          entries: [
            {
              id: "vision-model",
              name: "Vision model",
              provider: "test-provider",
              input: ["text", "image"] as ("text" | "image")[],
            },
          ],
          routeVariants: [],
        } satisfies Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>>;
        const catalog = createDeferred<typeof snapshot>();
        const loadCatalog = vi.fn(() => catalog.promise);
        const context = createDirectChatContext({
          getRuntimeConfig: () => cfg,
          chatQueuedTurns: new Map(),
          loadGatewayModelCatalogSnapshot: loadCatalog,
        });
        const profile = ensureProfileForEmail("attachment-sender@example.invalid");
        const sender = { id: profile.id, name: "Original employee" };
        const responses = vi.fn();
        const params = {
          sessionKey,
          message: "Original message with image",
          idempotencyKey: runId,
          attachments: [
            { type: "image", mimeType: "image/png", fileName: "dot.png", content: pngBase64 },
          ],
        };
        const options: GatewayRequestHandlerOptions = {
          req: { type: "req", id: runId, method: "chat.send", params },
          params,
          respond: responses,
          context,
          isWebchatConnect: () => true,
          client: {
            connId: "original-connection",
            authenticatedUserId: "attachment-sender@example.invalid",
            authenticatedUserProfile: {
              profileId: profile.id,
              displayName: sender.name,
              hasAvatar: false,
              updatedAt: Date.now(),
            },
            internal: { senderAttribution: sender },
            connect: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
                mode: GATEWAY_CLIENT_MODES.WEBCHAT,
                version: "test",
                platform: "test",
              },
              role: "operator",
              scopes: ["operator.write", "operator.admin"],
            },
          },
        };
        const realDispatch = dispatch.dispatchInboundMessageWithProjectedDispatcher;
        const resolver = vi.fn<InternalGetReplyFromConfig>(async (ctx, replyOptions) => {
          expect(ctx).toMatchObject({
            MessageSid: runId,
            SenderId: sender.id,
            SenderName: sender.name,
          });
          expect(ctx.BodyForAgent).toContain(params.message);
          expect(replyOptions).toMatchObject({
            runId,
            expectedExistingSessionId: nextSessionId,
            replyOperation: { sessionId: nextSessionId },
          });
          expect(replyOptions?.images).toHaveLength(1);
          const initialized = await initSessionState({
            ctx: finalizeInboundContext(ctx),
            cfg,
            commandAuthorized: true,
            expectedExistingSessionId: replyOptions?.expectedExistingSessionId,
            signal: replyOptions?.abortSignal,
          });
          expect(initialized.sessionId).toBe(nextSessionId);
          replyOptions?.onSessionPrepared?.({
            sessionKey,
            sessionId: initialized.sessionId,
            storePath,
          });
          expect(context.chatAbortControllers.get(runId)).toBe(originalCancelEntry);
          expect(originalCancelEntry?.sessionId).toBe(nextSessionId);
          expect(getAgentRunContext(runId)?.sessionId).toBe(nextSessionId);
          const persisted = await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
          expect(persisted?.message).toMatchObject({
            role: "user",
            idempotencyKey: `${runId}:user`,
            __openclaw: { senderId: sender.id, senderName: sender.name },
          });
          return { text: "Continuation completed" };
        });
        vi.spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher").mockImplementation(
          async (request) => await realDispatch({ ...request, replyResolver: resolver }),
        );
        let originalCancelEntry: ReturnType<typeof context.chatAbortControllers.get>;
        let reset: Promise<unknown> | undefined;
        const send = handleChatSend(options);
        try {
          // The real image-capability await occurs after locked admission, not
          // in a mocked attachment/admission implementation.
          await vi.waitFor(() => expect(loadCatalog).toHaveBeenCalledOnce());
          originalCancelEntry = context.chatAbortControllers.get(runId);
          expect(originalCancelEntry?.sessionId).toBe(originalSessionId);
          expect(responses).not.toHaveBeenCalled();
          if (scenario === "compaction") {
            await runWithReplyOperationLifecycleAdmission(
              owner.operation,
              async () =>
                await runExclusiveSessionLifecycleMutation({
                  scope: storePath,
                  identities: [sessionKey, originalSessionId],
                  kind: "compaction",
                  run: async () => {
                    await seed(nextSessionId);
                    owner.operation.updateSessionId(nextSessionId);
                  },
                }),
            );
          } else if (scenario === "replacement") {
            await seed(nextSessionId);
          }
          owner.operation.complete();
          expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
          if (scenario === "reset") {
            reset = runExclusiveSessionLifecycleMutation({
              scope: storePath,
              identities: [sessionKey, originalSessionId],
              prepare: async () => {
                await interruptSessionWorkAdmissions({
                  scope: storePath,
                  identities: [sessionKey],
                });
              },
              run: async () => await seed(nextSessionId),
            });
            await vi.waitFor(() =>
              expect(originalCancelEntry?.controller.signal.aborted).toBe(true),
            );
          }
          catalog.resolve(snapshot);
          await send;
          await reset;
          await vi.waitFor(() => expect(context.chatAbortControllers.has(runId)).toBe(false));
          const terminal = context.dedupe.get(`chat:${runId}`);
          expect(terminal?.payload).toMatchObject({ runId });
          const messages = loadTranscriptEventsSync({
            sessionKey,
            sessionId: nextSessionId,
            storePath,
          }).flatMap((event) => (event as { message?: { role?: string } }).message ?? []);
          const userMessages = messages.filter((message) => message.role === "user");
          if (scenario === "compaction") {
            expect(resolver).toHaveBeenCalledOnce();
            // Dispatch converts thrown resolver assertions into a visible chat
            // error; rethrow the original promise to retain its source stack.
            await resolver.mock.results[0]?.value;
            expect(terminal, JSON.stringify(terminal)).toMatchObject({
              ok: true,
              payload: { status: "ok" },
            });
            expect(userMessages).toEqual([
              expect.objectContaining({
                idempotencyKey: `${runId}:user`,
                __openclaw: expect.objectContaining({ senderId: sender.id }),
              }),
            ]);
            expect(context.broadcast).toHaveBeenCalledWith(
              "chat",
              expect.objectContaining({ runId, state: "final" }),
              expect.anything(),
            );
          } else {
            expect(resolver).not.toHaveBeenCalled();
            expect(userMessages).toEqual([]);
            if (scenario === "reset") {
              // The Gateway wire payload uses timeout for cancelled admissions;
              // summary and stopReason retain the authoritative reset outcome.
              expect(terminal?.payload, JSON.stringify(terminal)).toMatchObject({
                status: "timeout",
                summary: "aborted",
                stopReason: "restart",
              });
            } else {
              expect(terminal?.payload).toMatchObject({
                status: "error",
                summary: expect.stringContaining("Refresh the conversation, then send it again."),
              });
            }
          }
          expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(nextSessionId);
        } finally {
          owner.operation.complete();
          catalog.resolve(snapshot);
          await send;
          await reset;
          await vi.waitFor(() => expect(context.chatAbortControllers.has(runId)).toBe(false));
        }
      });
    },
  );
});
