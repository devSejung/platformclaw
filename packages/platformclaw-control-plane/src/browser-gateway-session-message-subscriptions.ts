type GatewayRequest = {
  request(method: string, params?: unknown): Promise<unknown>;
};

type SubscriptionParams = {
  key: string;
  agentId?: string;
  includeApprovals?: true;
};

function subscriptionId(params: Pick<SubscriptionParams, "key" | "agentId">): string {
  return JSON.stringify([params.key, params.agentId ?? null]);
}

/** Keeps browser-local message leases from cancelling the shared Gateway subscription. */
export class BrowserGatewaySessionMessageSubscriptions {
  private readonly activeConnections = new Set<string>();
  private readonly desired = new Map<string, Map<string, SubscriptionParams>>();
  private barrier = Promise.resolve();

  constructor(
    private readonly gateway: GatewayRequest,
    private readonly inactiveConnectionError: () => Error,
  ) {}

  registerConnection(connectionId: string): void {
    if (connectionId) {
      this.activeConnections.add(connectionId);
    }
  }

  subscribe(connectionId: string, params: SubscriptionParams): Promise<unknown> {
    const operation = this.barrier.then(async () => {
      this.assertActive(connectionId);
      const result = await this.gateway.request("sessions.messages.subscribe", params);
      if (!this.activeConnections.has(connectionId)) {
        const id = subscriptionId(params);
        if (!this.isDesiredElsewhere(id)) {
          await this.gateway.request("sessions.messages.unsubscribe", {
            key: params.key,
            ...(params.agentId ? { agentId: params.agentId } : {}),
          });
        }
        throw this.inactiveConnectionError();
      }
      const subscriptions = this.desired.get(connectionId) ?? new Map();
      subscriptions.set(subscriptionId(params), params);
      this.desired.set(connectionId, subscriptions);
      return result;
    });
    this.advanceBarrier(operation);
    return operation;
  }

  unsubscribe(
    connectionId: string,
    params: Pick<SubscriptionParams, "key" | "agentId">,
  ): Promise<unknown> {
    const operation = this.barrier.then(async () => {
      this.assertActive(connectionId);
      const id = subscriptionId(params);
      const subscriptions = this.desired.get(connectionId);
      subscriptions?.delete(id);
      if (subscriptions?.size === 0) {
        this.desired.delete(connectionId);
      }
      // The upstream registry is keyed only by its shared connection and session.
      // Preserve that lease until the final browser connection releases it.
      if (this.isDesiredElsewhere(id)) {
        return { subscribed: false };
      }
      return await this.gateway.request("sessions.messages.unsubscribe", params);
    });
    this.advanceBarrier(operation);
    return operation;
  }

  releaseConnection(connectionId: string): Promise<void> {
    if (!connectionId) {
      return Promise.resolve();
    }
    this.activeConnections.delete(connectionId);
    const released = this.desired.get(connectionId);
    this.desired.delete(connectionId);
    const operation = this.barrier.then(async () => {
      for (const [id, params] of released ?? []) {
        if (!this.isDesiredElsewhere(id)) {
          await this.gateway.request("sessions.messages.unsubscribe", {
            key: params.key,
            ...(params.agentId ? { agentId: params.agentId } : {}),
          });
        }
      }
    });
    this.advanceBarrier(operation);
    return operation;
  }

  private assertActive(connectionId: string): void {
    if (!this.activeConnections.has(connectionId)) {
      throw this.inactiveConnectionError();
    }
  }

  private isDesiredElsewhere(id: string): boolean {
    for (const subscriptions of this.desired.values()) {
      if (subscriptions.has(id)) {
        return true;
      }
    }
    return false;
  }

  private advanceBarrier(operation: Promise<unknown>): void {
    this.barrier = operation.then(
      () => undefined,
      () => undefined,
    );
  }
}
