import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { PluginHookReplyDispatchResult } from "../../plugins/hooks.test-fixtures.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { RuntimeMsgContext } from "../templating.js";
import {
  createDispatcher,
  createHookCtx,
  emptyConfig,
  hookMocks,
  resetPluginTtsAndThreadMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let resetReplyRunRegistry: () => void;

beforeAll(async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  const { testing } = await import("./reply-run-registry.test-support.js");
  resetReplyRunRegistry = () => testing.resetReplyRunRegistry();
});

beforeEach(() => {
  clearAgentHarnesses();
  resetReplyRunRegistry();
  setDiscordTestRegistry();
  resetInboundDedupe();
  resetPluginTtsAndThreadMocks();
  hookMocks.runner.runReplyDispatch.mockReset().mockResolvedValue(undefined);
  hookMocks.runner.hasHooks.mockImplementation(
    (hookName?: string) => hookName === "reply_dispatch",
  );
});

describe("source reply routing and delivery policy", () => {
  it("still applies send-policy deny after an unhandled plugin dispatch", async () => {
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: false,
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    } satisfies PluginHookReplyDispatchResult);

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: {
        ...emptyConfig,
        session: {
          sendPolicy: { default: "deny" },
        },
      },
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "model reply" }),
    });

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalled();
    // createHookCtx's "private" chat type is undirected, so no fallback
    // eligibility surfaces for this turn.
    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sendPolicyDenied: true,
      sourceTurnCompleted: true,
    });
  });

  it.each(["text", "native"] as const)(
    "normalizes bound %s slash answers before source routing and delivery policy",
    async (source) => {
      const sessionKey = "agent:test:session";
      const policy = vi.fn();
      const reply = { text: "Question expired; answer the latest prompt.", isError: true };
      setReplyPayloadMetadata(reply, { noVisibleReplyReason: "question-unavailable" });
      const replyResolver = vi.fn(async (ctx: RuntimeMsgContext) => {
        expect(ctx.SessionKey).toBe(sessionKey);
        expect(ctx.commandText).toBe("");
        expect(ctx.agentText).toBe("/status");
        expect(ctx.CommandTurn).toMatchObject({ kind: "normal", source: "message" });
        return reply;
      });
      const dispatcher = createDispatcher();
      const result = await dispatchReplyFromConfig({
        ctx: {
          ...createHookCtx(),
          Body: "/status",
          BodyForAgent: "/status",
          agentText: "/status",
          rawText: "/status",
          commandText: "/status",
          BodyForCommands: "/status",
          RawBody: "/status",
          CommandBody: "/status",
          ChatType: "group",
          WasMentioned: true,
          CommandSource: source,
          CommandAuthorized: false,
          CommandTurn:
            source === "native"
              ? {
                  kind: "native",
                  source: "native",
                  authorized: true,
                  commandName: "status",
                  body: "/status",
                }
              : {
                  kind: "text-slash",
                  source: "text",
                  authorized: false,
                  commandName: "status",
                  body: "/status",
                },
          CommandTargetSessionKey: "agent:other:wrong-target",
        },
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
        replyOptions: {
          questionAnswerBinding: { sessionKey, questionId: "expired-question" },
          onSourceReplyDeliveryPolicy: policy,
        },
      });
      expect(replyResolver).toHaveBeenCalledOnce();
      expect(policy).toHaveBeenCalledWith({
        sendPolicyDenied: false,
        sourceReplyDeliveryMode: "automatic",
      });
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(reply);
      expect(result.sourceReplyDeliveryMode).not.toBe("message_tool_only");
    },
  );
});
