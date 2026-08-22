type BrowserGatewaySessionPullRequestRpc = {
  request(method: string, params?: unknown): Promise<unknown>;
};

type SessionOwnerResolver = (sessionKey: string) => string | null;

const METHOD = "controlUi.sessionPullRequests.subscribe";

function signature(keys: ReadonlySet<string>): string {
  return JSON.stringify([...keys].toSorted((left, right) => left.localeCompare(right)));
}

/** Multiplexes browser PR watches over PlatformClaw's shared private Gateway connection. */
export class BrowserGatewaySessionPullRequestSubscriptions {
  private readonly activeConnections = new Set<string>();
  private readonly desired = new Map<string, Set<string>>();
  private readonly applied = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private barrier = Promise.resolve();
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly gateway: BrowserGatewaySessionPullRequestRpc,
    private readonly resolveAgentIdFromSessionKey: SessionOwnerResolver,
    private readonly inactiveConnectionError: () => Error,
  ) {}

  registerConnection(connectionId: string): void {
    if (connectionId) {
      this.activeConnections.add(connectionId);
    }
  }

  replace(
    connectionId: string,
    sessionKeys: readonly string[],
    refreshSessionKeys: readonly string[] = [],
  ): Promise<{ subscribed: boolean }> {
    const operation = this.barrier.then(async () => {
      if (!this.activeConnections.has(connectionId)) {
        throw this.inactiveConnectionError();
      }
      const next = new Set(sessionKeys);
      this.desired.set(connectionId, next);
      this.dirty.add(connectionId);
      await this.reconcile(connectionId, new Set(refreshSessionKeys));
      return { subscribed: next.size > 0 };
    });
    this.advanceBarrier(operation);
    return operation;
  }

  releaseConnection(connectionId: string): Promise<void> {
    if (!connectionId) {
      return Promise.resolve();
    }
    // Remove projection ownership before the asynchronous upstream unsubscribe.
    this.activeConnections.delete(connectionId);
    this.desired.delete(connectionId);
    this.applied.delete(connectionId);
    this.dirty.add(connectionId);
    const operation = this.barrier.then(() => this.reconcile(connectionId));
    this.advanceBarrier(operation);
    return operation;
  }

  handleGatewayDisconnect(): void {
    this.applied.clear();
    this.clearRetry();
  }

  projectEvent(
    connectionId: string,
    agentId: string,
    payload: unknown,
  ): { sessions: Record<string, unknown> } | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const rawSessions = (payload as { sessions?: unknown }).sessions;
    if (!rawSessions || typeof rawSessions !== "object" || Array.isArray(rawSessions)) {
      return null;
    }
    const watched = this.desired.get(connectionId);
    if (!watched || watched.size === 0) {
      return null;
    }
    const sessions: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [sessionKey, snapshot] of Object.entries(rawSessions)) {
      if (
        watched.has(sessionKey) &&
        this.resolveAgentIdFromSessionKey(sessionKey) === agentId &&
        snapshot &&
        typeof snapshot === "object" &&
        !Array.isArray(snapshot)
      ) {
        sessions[sessionKey] = snapshot;
      }
    }
    return Object.keys(sessions).length > 0 ? { sessions } : null;
  }

  private advanceBarrier(operation: Promise<unknown>): void {
    this.barrier = operation.then(
      () => undefined,
      () => undefined,
    );
  }

  private async reconcile(
    connectionId: string,
    refreshSessionKeys: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const sessionKeys = this.desired.get(connectionId) ?? new Set<string>();
    const nextSignature = signature(sessionKeys);
    if (refreshSessionKeys.size === 0 && this.applied.get(connectionId) === nextSignature) {
      this.dirty.delete(connectionId);
      return;
    }
    try {
      await this.gateway.request(METHOD, {
        sessionKeys: [...sessionKeys],
        ...(refreshSessionKeys.size > 0 ? { refreshSessionKeys: [...refreshSessionKeys] } : {}),
        subscriptionId: connectionId,
      });
    } catch (error) {
      this.applied.delete(connectionId);
      this.dirty.add(connectionId);
      this.scheduleRetry();
      throw error;
    }
    this.applied.set(connectionId, nextSignature);
    this.dirty.delete(connectionId);
    if (sessionKeys.size === 0) {
      this.applied.delete(connectionId);
    }
    if (this.dirty.size === 0) {
      this.clearRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }
    const delayMs = Math.min(250 * 2 ** this.retryAttempt, 5_000);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const retry = this.barrier.then(async () => {
        for (const connectionId of Array.from(this.dirty)) {
          try {
            await this.reconcile(connectionId);
          } catch {
            return;
          }
        }
      });
      this.advanceBarrier(retry);
      void retry.catch(() => undefined);
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retryAttempt = 0;
  }
}
