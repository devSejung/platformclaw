import {
  embeddedAgentLog,
  formatErrorMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  publishSessionTranscriptUpdateByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";

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
