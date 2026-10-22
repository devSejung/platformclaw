import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { findAgentRunTerminalOutcome, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  getReplyPayloadAgentRunTerminalOutcome,
  getReplyPayloadNoVisibleReplyReason,
} from "openclaw/plugin-sdk/reply-payload";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveKnoxCommandText } from "./command-text.js";
import { KnoxIngressPermanentError, type KnoxIngressLifecycle } from "./ingress.js";
import { resolveKnoxPendingQuestionText, type KnoxQuestionAnswerBinding } from "./input-routing.js";
import {
  buildKnoxTarget,
  KnoxOutboundError,
  sendKnoxOutbound,
  type KnoxOutboundContext,
} from "./outbound.js";
import { createKnoxProgress, usesKnoxKoreanNotices } from "./progress.js";
import { formatKnoxReplyFailure, type KnoxReplyFailureReason } from "./reply-notice.js";
import { renderKnoxReplyText } from "./reply-text.js";
import { KnoxRoutingClient, type KnoxRouteResolution } from "./routing-client.js";
import { getKnoxRuntime } from "./runtime.js";
import type { KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

function terminalFailureReason(terminal: {
  status: string;
  reason: string;
}): "timeout" | "cancelled" | "runtime-error" {
  return terminal.status === "timeout"
    ? "timeout"
    : terminal.reason === "cancelled" || terminal.reason === "aborted"
      ? "cancelled"
      : "runtime-error";
}

function describeSourceFailure(
  outcome: NonNullable<ReturnType<typeof getReplyPayloadAgentRunTerminalOutcome>>,
  knownReason?: KnoxReplyFailureReason,
): KnoxReplyFailureReason {
  const reason = terminalFailureReason(outcome);
  return reason === "runtime-error" ? (knownReason ?? reason) : reason;
}

function runtimeFailureReason(error: unknown): "timeout" | "cancelled" | "runtime-error" {
  const terminal = findAgentRunTerminalOutcome(error);
  if (terminal) {
    return terminalFailureReason(terminal);
  }
  let candidate = error;
  const seen = new Set<object>();
  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    const value = candidate as { name?: unknown; cause?: unknown };
    if (value.name === "TimeoutError") {
      return "timeout";
    }
    if (value.name === "AbortError") {
      return "cancelled";
    }
    candidate = value.cause;
  }
  return "runtime-error";
}

function isGatewayDrainingError(error: unknown): boolean {
  let candidate = error;
  const seen = new Set<object>();
  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    const value = candidate as { name?: unknown; cause?: unknown };
    // GatewayDrainingError is a runtime lifecycle signal, not a terminal agent failure.
    // Rethrowing lets durable ingress retry instead of sending a contradictory final error.
    if (value.name === "GatewayDrainingError") {
      return true;
    }
    candidate = value.cause;
  }
  return false;
}

/** Best-effort waiting notice; the durable request never waits for this acknowledgement. */
export async function sendKnoxQueuedNotice(params: {
  account: ResolvedKnoxAccount;
  message: KnoxInboundMessage;
  aheadCount: number;
  abortSignal: AbortSignal;
  route?: KnoxRouteResolution;
}): Promise<void> {
  if (params.abortSignal.aborted || params.aheadCount < 1) {
    return;
  }
  const routing =
    params.route ??
    (await new KnoxRoutingClient({
      url: params.account.controlPlaneUrl,
      token: params.account.serviceToken,
    }).resolve({
      accountId: params.account.accountId,
      conversationType: params.message.conversation.type,
      conversationId: params.message.conversation.conversationId,
      knoxUserId: params.message.sender.knoxUserId,
    }));
  // Dispatch/stop can win while the control-plane lookup is pending.
  if (params.abortSignal.aborted || routing.status !== "resolved") {
    return;
  }
  await sendKnoxOutbound({
    context: {
      account: params.account,
      inbound: params.message,
      agentId: routing.agentId,
      sessionKey: routing.sessionKey,
      runId: `knox:${params.message.messageId}`,
      ...(params.message.conversation.type === "dm" || params.message.schemaVersion === 2
        ? { executionTarget: requireDmExecutionTarget(routing.executionTarget) }
        : {}),
    },
    status: "progress",
    final: false,
    text: usesKnoxKoreanNotices(params.message.message.text)
      ? `앞선 요청 ${params.aheadCount}건 처리 후 이어서 진행합니다.`
      : `Your request will proceed after ${params.aheadCount} earlier request(s).`,
    requestId: `queued:${params.message.messageId}`,
    abortSignal: params.abortSignal,
  });
}

export async function dispatchKnoxInbound(params: {
  account: ResolvedKnoxAccount;
  message: KnoxInboundMessage;
  lifecycle: KnoxIngressLifecycle;
  questionAnswerBinding?: KnoxQuestionAnswerBinding;
  selfInSpace?: {
    route: KnoxRouteResolution;
    validate: () => Promise<void>;
    finish: (result: {
      text: string;
      status: "final" | "error" | "timeout";
      requestId?: string;
    }) => Promise<void>;
  };
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<void> {
  const runtime = getKnoxRuntime();
  const cfg = runtime.config.current() as OpenClawConfig;
  const routing =
    params.selfInSpace?.route ??
    (await new KnoxRoutingClient({
      url: params.account.controlPlaneUrl,
      token: params.account.serviceToken,
    }).resolve({
      accountId: params.account.accountId,
      conversationType: params.message.conversation.type,
      conversationId: params.message.conversation.conversationId,
      knoxUserId: params.message.sender.knoxUserId,
    }));
  if (routing.status === "login-required") {
    throw new KnoxIngressPermanentError(
      "login-required",
      `Knox sender ${params.message.sender.knoxUserId} has no linked Web account`,
    );
  }
  if (routing.status === "room-disabled") {
    throw new KnoxIngressPermanentError(
      "room-disabled",
      `Knox room ${params.message.conversation.conversationId} is disabled`,
    );
  }
  if (routing.status === "agent-unavailable") {
    if (params.message.conversation.type === "dm") {
      throw new KnoxIngressPermanentError(
        "agent-unavailable",
        `Knox sender ${params.message.sender.knoxUserId} has no active personal agent`,
      );
    }
    throw new Error("Knox target agent is unavailable");
  }

  if (routing.status !== "resolved") {
    throw new KnoxIngressPermanentError("agent-unavailable", "Knox target is unavailable");
  }
  const personal = params.message.schemaVersion === 2;
  if (personal && (!params.selfInSpace || !routing.selfInSpace)) {
    throw new KnoxIngressPermanentError(
      "invalid-event",
      "Knox personal request has no pinned target",
    );
  }
  const sendReply = async (input: Parameters<typeof sendKnoxOutbound>[0]): Promise<string> => {
    if (personal && input.final && params.selfInSpace) {
      await params.selfInSpace.finish({
        text: input.text,
        status:
          input.status === "timeout" ? "timeout" : input.status === "error" ? "error" : "final",
        requestId: input.requestId,
      });
      return input.requestId ?? `final:${params.message.messageId}`;
    }
    return await sendKnoxOutbound(input);
  };
  const target = buildKnoxTarget(
    params.message.conversation.type,
    params.message.conversation.conversationId,
  );
  const commandText = personal ? "" : resolveKnoxCommandText(params.message.message.text);
  const questionText = personal
    ? undefined
    : (params.questionAnswerBinding?.text ??
      resolveKnoxPendingQuestionText({
        sessionKey: routing.sessionKey,
        text: params.message.message.text,
      }));
  const agentText = questionText ?? params.message.message.text;
  const route = {
    agentId: routing.agentId,
    dmScope: "main" as const,
    sessionKey: routing.sessionKey,
  };
  const ctxPayload = runtime.channel.inbound.buildContext({
    channel: "knox",
    accountId: params.account.accountId,
    messageId: params.message.messageId,
    messageIdFull: params.message.messageId,
    timestamp: Date.parse(params.message.occurredAt),
    from: target,
    sender: {
      // Keep the raw dotted Knox identity. Agent IDs are a separate namespace.
      id: params.message.sender.knoxUserId,
      name: personal
        ? routing.selfInSpace!.senderAttribution.name
        : params.message.sender.displayName,
    },
    conversation: {
      kind: params.message.conversation.type === "dm" ? "direct" : "group",
      id: params.message.conversation.conversationId,
      label: params.message.conversation.displayName ?? params.message.conversation.conversationId,
      nativeChannelId: params.message.conversation.conversationId,
    },
    route: {
      agentId: routing.agentId,
      dmScope: "main",
      accountId: params.account.accountId,
      routeSessionKey: routing.sessionKey,
      dispatchSessionKey: routing.sessionKey,
    },
    reply: { to: target, originatingTo: target },
    message: {
      rawBody: params.message.message.text,
      commandBody: commandText,
      bodyForAgent: agentText,
    },
    access: {
      commands: { authorized: !personal && routing.senderLinked },
      // Control-plane routing binds DMs to linked personal agents and rooms to isolated room
      // agents. The room itself is the owner boundary, so every admitted participant owns it.
      owner: {
        authorized: personal
          ? routing.senderLinked
          : params.message.conversation.type === "room" || routing.senderLinked,
      },
      mentions: {
        canDetectMention: params.message.conversation.type === "room",
        wasMentioned: true,
      },
    },
    extra: {
      ProviderMessageId: params.message.messageId,
      NativeConversationId: params.message.conversation.conversationId,
      ...(personal
        ? {
            ReplyRouteScope: "request",
            SenderProfileId: routing.selfInSpace!.userId,
            SenderAgentId: routing.agentId,
          }
        : {}),
    },
  });
  const runId = personal
    ? `knox-my:${routing.selfInSpace!.admissionId}`
    : `knox:${params.message.messageId}`;
  const reference = createHash("sha256")
    .update(`${params.account.accountId}:${target}:${runId}`)
    .digest("hex")
    .slice(0, 12);
  const recordOutcome = (reason: string, error?: unknown) =>
    params.log?.info?.(
      JSON.stringify({
        event: "knox.reply.outcome",
        reference,
        runId,
        reason,
        ...(error === undefined
          ? {}
          : { error: redactSensitiveText(formatErrorMessage(error)).slice(0, 1_000) }),
      }),
    );
  const outboundContext: KnoxOutboundContext = {
    account: params.account,
    inbound: params.message,
    agentId: routing.agentId,
    sessionKey: routing.sessionKey,
    runId,
    ...(params.message.conversation.type === "dm" || personal
      ? { executionTarget: requireDmExecutionTarget(routing.executionTarget) }
      : {}),
  };
  let finalSent = false;
  let visibleReplySent = false;
  let recoveryReason: KnoxReplyFailureReason = "unknown";
  let deliveryFailure: Error | undefined;
  let deliveryPolicyResolved = false;
  let automaticReplySuppression: "send-policy-denied" | "message-tool-only" | undefined;
  let observedSourceFailure:
    | {
        outcome: NonNullable<ReturnType<typeof getReplyPayloadAgentRunTerminalOutcome>>;
        reason?: KnoxReplyFailureReason;
      }
    | undefined;
  let finalOrdinal = 0;
  let privateQuestionNoticeSent = false;
  let turnFinished = false;
  const progress = createKnoxProgress({
    privateExecution: personal,
    text: params.message.message.text,
    delayMs: params.account.progressDelayMs,
    abortSignal: params.lifecycle.abortSignal,
    subscribe: runtime.events.onAgentEvent,
    canSend: () => !turnFinished && deliveryPolicyResolved && !automaticReplySuppression,
    send: async (text, ordinal, abortSignal) => {
      await sendReply({
        context: outboundContext,
        status: "progress",
        text,
        final: false,
        requestId:
          ordinal === 0
            ? `progress:${params.message.messageId}`
            : `progress:${params.message.messageId}:${ordinal}`,
        abortSignal,
      });
    },
    warn: (error) =>
      params.log?.warn?.(
        `Knox progress delivery failed: ${redactSensitiveText(formatErrorMessage(error)).slice(0, 1_000)}`,
      ),
  });
  let deferred = false;
  let abandoned = false;
  let settleDeferredTurn = () => {};
  const deferredTurn = new Promise<void>((resolve) => {
    settleDeferredTurn = resolve;
  });
  const abandonDeferredWait = () => settleDeferredTurn();
  params.lifecycle.abortSignal.addEventListener("abort", abandonDeferredWait, { once: true });
  try {
    const turnAdoptionLifecycle: KnoxIngressLifecycle & { onSettled: () => void } = {
      ...params.lifecycle,
      onAdopted: async () => {
        await params.selfInSpace?.validate();
        await params.lifecycle.onAdopted();
        progress.start();
      },
      onDeferred: () => {
        deferred = true;
        // The followup owner reloads policy when it adopts the queued turn.
        // The initial allow decision cannot authorize its later progress/errors.
        deliveryPolicyResolved = false;
        progress.suspend();
        params.lifecycle.onDeferred();
      },
      onAbandoned: () => {
        abandoned = true;
        progress.stop();
        return params.lifecycle.onAbandoned();
      },
      onSettled: () => {
        progress.stop();
        settleDeferredTurn();
      },
    };
    const result = await runtime.channel.inbound.run({
      channel: "knox",
      accountId: params.account.accountId,
      raw: params.message,
      turnAdoptionLifecycle,
      adapter: {
        ingest: (message) => ({
          id: message.eventId,
          timestamp: Date.parse(message.occurredAt),
          rawText: message.message.text,
          textForAgent: agentText,
          textForCommands: commandText,
          raw: message,
        }),
        resolveTurn: async () => ({
          cfg,
          channel: "knox",
          accountId: params.account.accountId,
          route,
          ctxPayload,
          replyOptions: {
            ...progress.replyOptions,
            ...(personal
              ? {
                  runId,
                  inputMode: "message-data" as const,
                  sourceReplyDeliveryMode: "automatic" as const,
                  disableBlockStreaming: true,
                  suppressDefaultToolProgressMessages: true,
                  reasoningPayloadsEnabled: false,
                  commentaryPayloadsEnabled: false,
                }
              : {}),
            ...(!personal && params.questionAnswerBinding
              ? {
                  questionAnswerBinding: {
                    sessionKey: params.questionAnswerBinding.sessionKey,
                    questionId: params.questionAnswerBinding.questionId,
                  },
                }
              : {}),
            onAgentRunFailure: (outcome, reason) => {
              progress.stop();
              // Followups can fail after dispatch returned its queue admission.
              // Keep the owner's fact until the deferred lifecycle settles.
              observedSourceFailure = { outcome, reason: reason ?? observedSourceFailure?.reason };
            },
            onSourceReplyDeliveryPolicy: ({ sendPolicyDenied, sourceReplyDeliveryMode }) => {
              // Read the owner's decision before adoption or a thrown run can
              // bypass the result flags with a channel-owned progress/error notice.
              deliveryPolicyResolved = true;
              automaticReplySuppression = sendPolicyDenied
                ? "send-policy-denied"
                : sourceReplyDeliveryMode === "message_tool_only"
                  ? "message-tool-only"
                  : undefined;
              if (automaticReplySuppression) {
                progress.suspend();
              }
            },
          },
          delivery: {
            durable: () => false,
            onError: (error) => {
              // Dispatcher settlement can swallow transport exceptions. Keep the
              // native failure and correlation before the outer run loses it.
              deliveryFailure ??=
                error instanceof Error
                  ? error
                  : new Error(formatErrorMessage(error), { cause: error });
              recordOutcome("delivery-failed", error);
            },
            deliver: async (payload, info) => {
              if (
                personal &&
                isRecord(payload.channelData?.askUser) &&
                !privateQuestionNoticeSent
              ) {
                privateQuestionNoticeSent = true;
                await sendReply({
                  context: outboundContext,
                  status: "progress",
                  text: usesKnoxKoreanNotices(params.message.message.text)
                    ? "소유자 웹에서 확인이 필요합니다. 비밀값은 Credential 등 비공개 입력 경로를 사용해 주세요."
                    : "Owner action is required in the web app. Enter secrets only through private Credential or approval inputs.",
                  final: false,
                  requestId: `waiting:${params.message.messageId}`,
                });
              }
              if (
                personal &&
                (info.kind !== "final" ||
                  isRecord(payload.channelData?.askUser) ||
                  payload.isReasoning ||
                  payload.isReasoningSnapshot)
              ) {
                return { visibleReplySent: false };
              }
              const terminalOutcome = getReplyPayloadAgentRunTerminalOutcome(payload);
              const knownReason = getReplyPayloadNoVisibleReplyReason(payload);
              const reason =
                terminalOutcome && terminalOutcome.status !== "ok"
                  ? describeSourceFailure(terminalOutcome, knownReason)
                  : knownReason;
              const question = isRecord(payload.channelData?.askUser);
              // Stop at receipt: rendering public links can await DNS beyond the next tick.
              // Prompts and tool/block replies remain visible progress, not completion.
              const terminal = info.kind === "final" && !question;
              if (terminal) {
                turnFinished = true;
                progress.stop();
              }
              progress.visibleReply();
              await progress.drain();
              const rendered = reason ? undefined : await renderKnoxReplyText(payload);
              const diagnosis = reason ?? (!rendered ? "unrenderable-result" : undefined);
              const text = diagnosis ? formatKnoxReplyFailure(diagnosis, reference) : rendered!;
              const deliveryOrdinal = finalOrdinal++;
              const messageId = await sendReply({
                context: outboundContext,
                status: terminal
                  ? diagnosis === "timeout"
                    ? "timeout"
                    : diagnosis || payload.isError
                      ? "error"
                      : "final"
                  : "progress",
                text,
                final: terminal,
                requestId: `final:${params.message.messageId}:${deliveryOrdinal}`,
              });
              visibleReplySent = true;
              finalSent ||= terminal;
              if (diagnosis || question || terminal) {
                recordOutcome(
                  diagnosis ??
                    (question ? "waiting-for-user" : payload.isError ? "error" : "delivered"),
                  terminalOutcome?.error,
                );
              }
              return { visibleReplySent: true, messageIds: [messageId], content: text };
            },
          },
          record: {
            onRecordError: (error) =>
              params.log?.warn?.(`Knox session record failed: ${String(error)}`),
          },
        }),
      },
    });
    // Followup dispatch returns at enqueue; its lifecycle ends after delivery or abandonment.
    if (deferred && !params.lifecycle.abortSignal.aborted) {
      await deferredTurn;
    }
    // A started processing notice must acknowledge before its UI can be closed.
    progress.stop();
    await progress.drain();
    if (deliveryFailure !== undefined) {
      throw deliveryFailure;
    }
    if (result.dispatched) {
      recoveryReason = result.dispatchResult.noVisibleReplyReason ?? "unknown";
      // A refreshed allow decision has no suppression value. It still supersedes
      // the initial queued result, whose deny flag may now be stale.
      const suppression = deliveryPolicyResolved
        ? automaticReplySuppression
        : result.dispatchResult.sendPolicyDenied === true
          ? "send-policy-denied"
          : result.dispatchResult.sourceReplyDeliveryMode === "message_tool_only"
            ? "message-tool-only"
            : undefined;
      if (suppression) {
        // Eligibility reports missing visibility, not permission to override policy.
        recordOutcome(suppression);
        return;
      }
      const sourceFailure =
        observedSourceFailure?.outcome ?? result.dispatchResult.sourceTurnFailure;
      if (sourceFailure && !finalSent && !params.lifecycle.abortSignal.aborted && !abandoned) {
        const reason = describeSourceFailure(
          sourceFailure,
          observedSourceFailure?.reason ?? result.dispatchResult.noVisibleReplyReason,
        );
        recordOutcome(reason, sourceFailure.error);
        await sendReply({
          context: outboundContext,
          status: reason === "timeout" ? "timeout" : "error",
          text: formatKnoxReplyFailure(reason, reference),
          final: true,
          requestId: `error:${params.message.messageId}`,
        });
        finalSent = true;
      }
      // Block-streamed answers may consume/dedupe the final payload. Only the
      // dispatch owner's settled fact closes them; questions and adopted input do not.
      if (
        !finalSent &&
        (visibleReplySent || progress.sent) &&
        !abandoned &&
        !params.lifecycle.abortSignal.aborted &&
        !sourceFailure &&
        result.dispatchResult.noVisibleReplyFallbackEligible !== true &&
        result.dispatchResult.sourceTurnCompleted === true
      ) {
        await sendReply({
          context: outboundContext,
          status: "final",
          text: usesKnoxKoreanNotices(params.message.message.text)
            ? "요청 처리가 끝났습니다."
            : "Your request is complete.",
          final: true,
          requestId: `complete:${params.message.messageId}`,
        });
        finalSent = true;
        recordOutcome("completed");
      }
    }
    if (
      abandoned ||
      params.lifecycle.abortSignal.aborted ||
      !result.dispatched ||
      result.dispatchResult.noVisibleReplyFallbackEligible !== true
    ) {
      return;
    }
  } catch (error) {
    turnFinished = true;
    progress.stop();
    await progress.drain();
    // Preserve the native failure for ingress; a second notice could contradict
    // a partially acknowledged final after an ambiguous transport timeout.
    if (error instanceof KnoxOutboundError || isGatewayDrainingError(error)) {
      throw error;
    }
    // A delivered final uses stable idempotency on retry. Never follow it with a
    // contradictory terminal message when later turn finalization fails.
    if (finalSent) {
      throw error;
    }
    const reason = runtimeFailureReason(error);
    const timedOut = reason === "timeout";
    recordOutcome(reason, error);
    if (automaticReplySuppression) {
      recordOutcome(automaticReplySuppression);
      return;
    }
    // If setup failed before policy resolution, ingress owns retry/reporting;
    // the channel has no authoritative permission for a direct failure notice.
    if (!deliveryPolicyResolved) {
      throw error;
    }
    await sendReply({
      context: outboundContext,
      status: timedOut ? "timeout" : "error",
      text: formatKnoxReplyFailure(reason, reference),
      final: true,
      requestId: `${timedOut ? "timeout" : "error"}:${params.message.messageId}`,
    });
    return;
  } finally {
    params.lifecycle.abortSignal.removeEventListener("abort", abandonDeferredWait);
    turnFinished = true;
    progress.stop();
    // Keep the ingress lane until any started progress delivery has also settled.
    await progress.drain();
  }
  if (!finalSent) {
    recordOutcome(recoveryReason);
    await sendReply({
      context: outboundContext,
      status: "error",
      text: formatKnoxReplyFailure(recoveryReason, reference),
      final: true,
      requestId: `error:${params.message.messageId}`,
    });
  }
}

function requireDmExecutionTarget(
  value: "platform_server" | "assigned_vm" | null,
): "platform_server" | "assigned_vm" {
  if (!value) {
    throw new Error("Knox DM routing response is missing executionTarget");
  }
  return value;
}
