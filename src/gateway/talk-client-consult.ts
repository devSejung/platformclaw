import type { ChatSenderAttribution } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { normalizeTalkSection } from "../config/talk.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { consultRealtimeVoiceAgent } from "../talk/agent-consult-runtime.js";
import {
  assertClientVoiceSessionOpen,
  registerClientVoiceConsultRun,
} from "../talk/client-voice-session.js";
import type { InternalRealtimeVoiceBrowserSessionCreateRequest } from "../talk/provider-internal.js";
import { registerChatAbortController } from "./chat-abort.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import type { TalkClientSessionOwner } from "./talk-client-session-owner.js";

/** Provider callbacks recheck the voice owner after all consult setup awaits. */
export function createTalkClientConsultRunner(params: {
  config: OpenClawConfig;
  context: {
    logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
    chatAbortControllers: GatewayRequestContext["chatAbortControllers"];
  };
  agentId: string;
  sessionKey: string;
  connId?: string;
  senderAttribution?: ChatSenderAttribution;
  initialItems: Array<{ role: "user" | "assistant"; text: string }>;
  owner: TalkClientSessionOwner;
  getVoiceSessionId: () => string | undefined;
}): NonNullable<InternalRealtimeVoiceBrowserSessionCreateRequest["runAgentConsult"]> {
  let agentRuntime: ReturnType<typeof createPluginRuntime>["agent"] | undefined;
  const assertOpen = () => {
    params.owner.assertAccepting();
    const voiceSessionId = params.getVoiceSessionId();
    if (!voiceSessionId) {
      throw new Error("Realtime browser voice session is not ready for agent consult");
    }
    assertClientVoiceSessionOpen({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      voiceSessionId,
    });
    return voiceSessionId;
  };
  return async ({ prompt, signal }) => {
    assertOpen();
    const consultSignal = params.owner.consultSignal(signal);
    try {
      agentRuntime ??= createPluginRuntime().agent;
      const talk = normalizeTalkSection(params.config.talk);
      return await consultRealtimeVoiceAgent({
        cfg: params.config,
        agentRuntime,
        logger: params.context.logGateway,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        senderId: params.senderAttribution?.id,
        senderAgentId: params.senderAttribution?.agentId,
        senderIsOwner: params.senderAttribution?.isOwner,
        messageProvider: "webchat",
        lane: "talk",
        runIdPrefix: "talk-realtime-consult",
        args: { question: prompt },
        transcript: params.initialItems,
        surface: "a browser Talk session",
        userLabel: "User",
        questionSourceLabel: "user",
        thinkLevel: talk?.consultThinkingLevel,
        fastMode: talk?.consultFastMode,
        abortSignal: consultSignal.signal,
        onRunStarted: ({ runId, sessionId, timeoutMs }) => {
          consultSignal.signal.throwIfAborted();
          const voiceSessionId = assertOpen();
          registerClientVoiceConsultRun({
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            voiceSessionId,
            runId,
            config: params.config,
          });
          consultSignal.markStarted();
          if (!params.connId) {
            return undefined;
          }
          const registration = registerChatAbortController({
            chatAbortControllers: params.context.chatAbortControllers,
            runId,
            sessionId,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            timeoutMs,
            ownerConnId: params.connId,
            controlUiVisible: false,
            kind: "chat-send",
          });
          return { abortSignal: registration.controller.signal, cleanup: registration.cleanup };
        },
      });
    } finally {
      consultSignal.cleanup();
    }
  };
}
