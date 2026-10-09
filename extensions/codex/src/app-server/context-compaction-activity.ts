import {
  embeddedAgentLog,
  formatErrorMessage,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
  type AgentMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  publishSessionTranscriptUpdateByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";

export function createCodexContextCompactionActivity(
  params: EmbeddedRunAttemptParams,
  threadId: string,
  turnId: string,
  callbacks: {
    emitAgentEvent: (
      event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
    ) => void;
    readMirroredSessionMessages: () => Promise<AgentMessage[]>;
    nextTranscriptTimestamp: () => number;
    onContextCompacted: () => void;
  },
) {
  // Hooks read the current run attribution at their boundary, not construction.
  const hookContext = () => ({
    runId: params.runId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider ?? undefined,
    trigger: params.trigger,
    channelId: params.messageChannel ?? params.messageProvider ?? undefined,
  });
  const emit = (itemId: string, phase: "start" | "end") =>
    callbacks.emitAgentEvent({
      stream: "compaction",
      data: {
        phase,
        backend: "codex-app-server",
        ...(phase === "end" ? { completed: true } : {}),
        threadId,
        turnId,
        itemId,
      },
    });
  return {
    async started(itemId: string): Promise<void> {
      await runAgentHarnessBeforeCompactionHook({
        sessionFile: params.sessionFile,
        messages: await callbacks.readMirroredSessionMessages(),
        ctx: hookContext(),
      });
      emit(itemId, "start");
    },
    async completed(itemId: string): Promise<void> {
      // Native context invalidation precedes the durable marker. After-hooks
      // and live completion must observe the persisted boundary.
      callbacks.onContextCompacted();
      await persistCodexContextCompactionActivity({
        sessionTarget: params.sessionTarget,
        config: params.config,
        cwd: params.workspaceDir,
        runId: params.runId,
        threadId,
        turnId,
        itemId,
        timestamp: callbacks.nextTranscriptTimestamp(),
      });
      await runAgentHarnessAfterCompactionHook({
        sessionFile: params.sessionFile,
        messages: await callbacks.readMirroredSessionMessages(),
        compactedCount: -1,
        ctx: hookContext(),
      });
      emit(itemId, "end");
    },
  };
}

/** Native Codex owns history; this bounded display-only record preserves its completed boundary. */
export async function persistCodexContextCompactionActivity(params: {
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
  config?: EmbeddedRunAttemptParams["config"];
  cwd?: string;
  runId?: string;
  threadId: string;
  turnId: string;
  itemId: string;
  timestamp: number;
}): Promise<void> {
  const target = params.sessionTarget;
  if (!target?.sessionId || !target.sessionKey || !target.storePath) {
    return;
  }
  const activityId = `codex-context-compaction:${params.threadId}:${params.turnId}:${params.itemId}`;
  const message = {
    role: "custom" as const,
    customType: "openclaw.context-compaction",
    content: "Context compacted",
    display: true,
    excludeFromContext: true,
    details: {
      kind: "context_compaction",
      backend: "codex-app-server",
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      ...(params.runId ? { runId: params.runId } : {}),
    },
    __openclaw: { itemId: params.itemId, ...(params.runId ? { runId: params.runId } : {}) },
    timestamp: params.timestamp,
    idempotencyKey: activityId,
  };
  try {
    const outcome = await appendSessionTranscriptMessageByIdentityStrict({
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      config: params.config,
      cwd: params.cwd,
      eventId: activityId,
      message,
    });
    // A completed native item belongs to the exact session that started it.
    if (outcome.kind !== "result" || !outcome.result.appended) {
      return;
    }
    const appended = outcome.result;
    await publishSessionTranscriptUpdateByIdentity({
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      update: {
        message: appended.message,
        messageId: appended.messageId,
        ...(params.runId ? { runId: params.runId } : {}),
      },
    });
  } catch (error) {
    embeddedAgentLog.warn("failed to persist codex context compaction activity", {
      error: formatErrorMessage(error),
      itemId: params.itemId,
    });
  }
}
