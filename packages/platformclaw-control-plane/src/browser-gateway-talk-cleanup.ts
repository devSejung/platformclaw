import type { BrowserGatewayProxyOptions } from "./browser-gateway-contracts.js";

type CleanupLease = {
  id: string;
  kind: "client" | "realtime" | "transcription";
  sessionKey: string;
  userId: string;
  bindingId: string;
  agentId: string;
  drain?: { acknowledged: boolean };
};
type CleanupOptions = Pick<BrowserGatewayProxyOptions, "gateway" | "auditWriter" | "now">;

export async function recordBrowserTalkCleanup(
  options: CleanupOptions,
  lease: CleanupLease,
  reason: string,
  outcome: string,
): Promise<void> {
  await options.auditWriter
    .recordAuditEvent({
      actorUserId: lease.userId,
      eventType: "browser.talk.closed",
      targetType: "agent-binding",
      targetId: lease.bindingId,
      details: { agentId: lease.agentId, voiceSessionId: lease.id, reason, outcome },
      createdAt: (options.now ?? Date.now)(),
    })
    .catch(() => {
      // Timers have no requester to receive a rejection. Keep the cleanup outcome
      // visible to operators even when durable audit storage is unavailable.
      console.warn("[platformclaw] Browser Talk cleanup audit failed", {
        voiceSessionId: lease.id,
        reason,
        outcome,
      });
    });
}

export async function cleanupBrowserTalkLease(
  options: CleanupOptions,
  lease: CleanupLease,
  reason: string,
): Promise<void> {
  if (lease.drain?.acknowledged) {
    await recordBrowserTalkCleanup(options, lease, reason, "provider_draining");
    return;
  }
  let outcome = "closed";
  try {
    await options.gateway.request(
      lease.kind === "client" ? "talk.client.close" : "talk.session.close",
      lease.kind === "client"
        ? { sessionKey: lease.sessionKey, voiceSessionId: lease.id }
        : { sessionId: lease.id },
    );
  } catch {
    outcome = "cleanup_failed";
  }
  await recordBrowserTalkCleanup(options, lease, reason, outcome);
}
