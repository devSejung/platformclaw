import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveKnoxCommandText } from "./command-text.js";
import { KnoxIngressPermanentError, type KnoxIngressLifecycle } from "./ingress.js";
import {
  buildKnoxTarget,
  KnoxOutboundError,
  sendKnoxOutbound,
  type KnoxOutboundContext,
} from "./outbound.js";
import { KnoxRoutingClient } from "./routing-client.js";
import { getKnoxRuntime } from "./runtime.js";
import type { KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

function isRuntimeTimeout(error: unknown): boolean {
  let candidate = error;
  const seen = new Set<object>();
  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    const value = candidate as {
      name?: unknown;
      terminalOutcome?: { status?: unknown; reason?: unknown };
      cause?: unknown;
    };
    if (
      value.name === "TimeoutError" ||
      value.terminalOutcome?.status === "timeout" ||
      value.terminalOutcome?.reason === "timeout"
    ) {
      return true;
    }
    candidate = value.cause;
  }
  return false;
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
}): Promise<void> {
  if (params.abortSignal.aborted || params.aheadCount < 1) {
    return;
  }
  const routing = await new KnoxRoutingClient({
    url: params.account.controlPlaneUrl,
    token: params.account.serviceToken,
  }).resolve({
    accountId: params.account.accountId,
    conversationType: params.message.conversation.type,
    conversationId: params.message.conversation.conversationId,
    knoxUserId: params.message.sender.knoxUserId,
  });
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
      ...(params.message.conversation.type === "dm"
        ? { executionTarget: requireDmExecutionTarget(routing.executionTarget) }
        : {}),
    },
    status: "progress",
    final: false,
    text: `앞선 요청 ${params.aheadCount}건 처리 후 이어서 진행합니다.`,
    requestId: `queued:${params.message.messageId}`,
    abortSignal: params.abortSignal,
  });
}

export async function dispatchKnoxInbound(params: {
  account: ResolvedKnoxAccount;
  message: KnoxInboundMessage;
  lifecycle: KnoxIngressLifecycle;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<void> {
  const runtime = getKnoxRuntime();
  const cfg = runtime.config.current() as OpenClawConfig;
  const routing = await new KnoxRoutingClient({
    url: params.account.controlPlaneUrl,
    token: params.account.serviceToken,
  }).resolve({
    accountId: params.account.accountId,
    conversationType: params.message.conversation.type,
    conversationId: params.message.conversation.conversationId,
    knoxUserId: params.message.sender.knoxUserId,
  });
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

  const target = buildKnoxTarget(
    params.message.conversation.type,
    params.message.conversation.conversationId,
  );
  const commandText = resolveKnoxCommandText(params.message.message.text);
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
      name: params.message.sender.displayName,
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
      bodyForAgent: params.message.message.text,
    },
    access: {
      commands: { authorized: routing.senderLinked },
      // Control-plane routing binds DMs to linked personal agents and rooms to isolated room
      // agents. The room itself is the owner boundary, so every admitted participant owns it.
      owner: {
        authorized: params.message.conversation.type === "room" || routing.senderLinked,
      },
      mentions: {
        canDetectMention: params.message.conversation.type === "room",
        wasMentioned: true,
      },
    },
    extra: {
      ProviderMessageId: params.message.messageId,
      NativeConversationId: params.message.conversation.conversationId,
    },
  });
  const runId = `knox:${params.message.messageId}`;
  const outboundContext: KnoxOutboundContext = {
    account: params.account,
    inbound: params.message,
    agentId: routing.agentId,
    sessionKey: routing.sessionKey,
    runId,
    ...(params.message.conversation.type === "dm"
      ? { executionTarget: requireDmExecutionTarget(routing.executionTarget) }
      : {}),
  };
  let finalSent = false;
  let finalOrdinal = 0;
  let turnFinished = false;
  let progressTask: Promise<void> | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let adopted = false;
  let deferred = false;
  let abandoned = false;
  let settleDeferredTurn = () => {};
  const deferredTurn = new Promise<void>((resolve) => {
    settleDeferredTurn = resolve;
  });
  const abandonDeferredWait = () => settleDeferredTurn();
  params.lifecycle.abortSignal.addEventListener("abort", abandonDeferredWait, { once: true });
  const startProgressTimer = () => {
    // Waiting and processing are distinct phases; adoption starts this delay.
    if (adopted || turnFinished || params.lifecycle.abortSignal.aborted) {
      return;
    }
    adopted = true;
    progressTimer = setTimeout(() => {
      if (turnFinished || params.lifecycle.abortSignal.aborted) {
        return;
      }
      progressTask = sendKnoxOutbound({
        context: outboundContext,
        status: "progress",
        text: "요청을 처리 중입니다.",
        final: false,
        requestId: `progress:${params.message.messageId}`,
      })
        .then(() => undefined)
        .catch((error: unknown) =>
          params.log?.warn?.(`Knox progress delivery failed: ${String(error)}`),
        );
    }, params.account.progressDelayMs);
    progressTimer.unref?.();
  };

  try {
    const turnAdoptionLifecycle: KnoxIngressLifecycle & { onSettled: () => void } = {
      ...params.lifecycle,
      onAdopted: async () => {
        await params.lifecycle.onAdopted();
        startProgressTimer();
      },
      onDeferred: () => {
        deferred = true;
        params.lifecycle.onDeferred();
      },
      onAbandoned: () => {
        abandoned = true;
        return params.lifecycle.onAbandoned();
      },
      onSettled: settleDeferredTurn,
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
          textForAgent: message.message.text,
          textForCommands: commandText,
          raw: message,
        }),
        resolveTurn: async () => ({
          cfg,
          channel: "knox",
          accountId: params.account.accountId,
          route,
          ctxPayload,
          delivery: {
            durable: () => false,
            deliver: async (payload) => {
              const text = payload.text;
              if (!text?.trim()) {
                return { visibleReplySent: false };
              }
              turnFinished = true;
              clearTimeout(progressTimer);
              await progressTask;
              const deliveryOrdinal = finalOrdinal++;
              await sendKnoxOutbound({
                context: outboundContext,
                status: "final",
                text,
                final: true,
                requestId: `final:${params.message.messageId}:${deliveryOrdinal}`,
              });
              finalSent = true;
              return { visibleReplySent: true };
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
    if (
      abandoned ||
      !result.dispatched ||
      result.dispatchResult.noVisibleReplyFallbackEligible !== true
    ) {
      return;
    }
  } catch (error) {
    turnFinished = true;
    clearTimeout(progressTimer);
    await progressTask;
    // A stable final delivery is retried by durable ingress. Sending a distinct
    // error here could produce contradictory terminal messages after an ambiguous timeout.
    if (error instanceof KnoxOutboundError || isGatewayDrainingError(error)) {
      throw error;
    }
    // A delivered final uses stable idempotency on retry. Never follow it with a
    // contradictory terminal message when later turn finalization fails.
    if (finalSent) {
      throw error;
    }
    const timedOut = isRuntimeTimeout(error);
    await sendKnoxOutbound({
      context: outboundContext,
      status: timedOut ? "timeout" : "error",
      text: timedOut
        ? "The request timed out before completion."
        : "The request could not be completed.",
      final: true,
      requestId: `${timedOut ? "timeout" : "error"}:${params.message.messageId}`,
    });
    return;
  } finally {
    params.lifecycle.abortSignal.removeEventListener("abort", abandonDeferredWait);
    turnFinished = true;
    clearTimeout(progressTimer);
    // Keep the ingress lane until any started progress delivery has also settled.
    await progressTask;
  }
  if (!finalSent) {
    await sendKnoxOutbound({
      context: outboundContext,
      status: "error",
      text: "No response was generated.",
      final: true,
      requestId: `error:${params.message.messageId}`,
    });
    params.log?.warn?.(`Knox turn completed without final text: ${params.message.eventId}`);
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
