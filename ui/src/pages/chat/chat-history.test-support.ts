import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChatHistoryResult, ChatState } from "./chat-history.ts";
import type { handleAgentEvent, ToolStreamEntry } from "./tool-stream.ts";

export type ChatHistoryTestState = ChatState &
  Parameters<typeof handleAgentEvent>[0] & {
    requestUpdate: () => void;
  };

export function createChatHistoryTestState(result: ChatHistoryResult): ChatHistoryTestState {
  const client = {
    request: vi.fn().mockResolvedValue(result),
  } as unknown as GatewayBrowserClient;
  return {
    client,
    connected: true,
    connectionEpoch: 1,
    sessionKey: "main",
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatStreamSegments: [],
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    planStatus: {
      runId: "stale-run",
      steps: [{ step: "Reset me", status: "in_progress" }],
    },
    lastError: null,
    hello: null,
    sessions: {
      setModelOverride: vi.fn(),
    },
    requestUpdate: vi.fn(),
  };
}
