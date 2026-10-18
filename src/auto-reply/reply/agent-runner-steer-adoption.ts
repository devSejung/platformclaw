import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isIngressAdoptionLostError } from "../../channels/message/ingress-drain.js";
import { logVerbose } from "../../globals.js";
import { runBeforeAgentReplyForTurn } from "../../plugins/before-agent-reply.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../plugins/hook-agent-context.js";
import type { RunReplyAgentParams } from "./agent-runner-core.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { type ReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";

export async function finalizeAcceptedSteer(params: {
  activeReplyOperation: ReplyOperation | undefined;
  abortKey: string | undefined;
  cleanupTyping: () => void;
  errorMessage: string | undefined;
  onAdopted: (() => void | Promise<void>) | undefined;
  replyOperationRunState: ReplyOperationRunState | undefined;
  steerSessionId: string;
  transcriptCommit: "unconfirmed" | undefined;
}): Promise<"continue" | "stop"> {
  const transcriptCommitUnconfirmed = params.transcriptCommit === "unconfirmed";
  if (params.replyOperationRunState) {
    // Harness acceptance has transferred this turn to the active session.
    // Replay after an uncertain receipt could run the same user side effects twice.
    params.replyOperationRunState.admission = { status: "accepted", mode: "steer" };
  }
  params.activeReplyOperation?.recordActivity();
  const abortActiveRun = () => {
    if (params.abortKey) {
      replyRunRegistry.abort(params.abortKey);
    }
  };
  if (transcriptCommitUnconfirmed) {
    // Work without a confirmed canonical transcript must stop, but the source
    // remains adopted because harness acceptance is already irreversible.
    abortActiveRun();
    logVerbose(
      `queue: active session ${params.steerSessionId} accepted steering without transcript confirmation; aborting active run without ingress replay (${params.errorMessage ?? "unknown receipt failure"})`,
    );
  }
  const adoptionBoundary = transcriptCommitUnconfirmed ? "harness acceptance" : "transcript commit";
  try {
    await params.onAdopted?.();
  } catch (error) {
    if (isIngressAdoptionLostError(error)) {
      abortActiveRun();
      logVerbose(
        `queue: active session ${params.steerSessionId} adoption lost after ${adoptionBoundary} (${error.code}); aborting steered turn without ingress replay`,
      );
      params.cleanupTyping();
      return "stop";
    }
    logVerbose(
      `queue: active session ${params.steerSessionId} adoption finalizer failed after ${adoptionBoundary}: ${String(error)}`,
    );
  }
  if (transcriptCommitUnconfirmed) {
    params.cleanupTyping();
    return "stop";
  }
  return "continue";
}

export async function runSteeredTurnBeforeReply(
  params: Pick<RunReplyAgentParams, "followupRun" | "sessionCtx" | "opts" | "sessionKey"> & {
    steerSessionId: string;
    sourceTurnId: string | undefined;
  },
) {
  const { followupRun, sessionCtx, opts, sessionKey, steerSessionId, sourceTurnId } = params;
  // Channel dispatch normally stamps the route-scoped source id. Internal
  // callers can derive the same per-message identity from the prepared turn.
  const steerRunId = expectDefined(
    sourceTurnId ??
      buildChannelSourceTurnId({
        provider:
          followupRun.originatingChannel ?? followupRun.run.messageProvider ?? sessionCtx.Provider,
        accountId:
          followupRun.originatingAccountId ??
          followupRun.run.agentAccountId ??
          sessionCtx.AccountId,
        conversationId:
          followupRun.originatingTo ??
          followupRun.originatingChatId ??
          sessionKey ??
          followupRun.run.sessionKey,
        messageId: followupRun.messageId ?? sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      }) ??
      normalizeOptionalString(opts?.runId),
    "steered turn id",
  );
  const trigger = "user";
  const hookResult = await runBeforeAgentReplyForTurn({
    runId: steerRunId,
    trigger,
    event: { cleanedBody: followupRun.prompt },
    context: {
      runId: steerRunId,
      agentId: followupRun.run.agentId,
      sessionKey: sessionKey ?? followupRun.run.sessionKey,
      sessionId: steerSessionId,
      workspaceDir: followupRun.run.workspaceDir,
      modelProviderId: followupRun.run.provider,
      modelId: followupRun.run.model,
      trigger,
      ...buildAgentHookContextChannelFields({
        sessionKey: sessionKey ?? followupRun.run.sessionKey,
        messageChannel: followupRun.originatingChannel,
        messageProvider: followupRun.run.messageProvider,
        currentChannelId: followupRun.originatingChatId,
        messageTo: followupRun.originatingTo,
        senderId: followupRun.run.senderId,
      }),
      ...buildAgentHookContextIdentityFields({
        trigger,
        senderId: followupRun.run.senderId,
        chatId: followupRun.originatingChatId,
        channelContext: followupRun.run.channelContext,
      }),
    },
  });
  return hookResult;
}
