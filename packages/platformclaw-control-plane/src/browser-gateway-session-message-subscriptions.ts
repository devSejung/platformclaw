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

  subscribe(
    connectionId: string,
    params: SubscriptionParams,
    gateway: GatewayRequest = this.gateway,
  ): Promise<unknown> {
    const operation = this.barrier.then(async () => {
      this.assertActive(connectionId);
      const result = await gateway.request("sessions.messages.subscribe", params);
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
    gateway: GatewayRequest = this.gateway,
  ): Promise<unknown> {
    const operation = this.barrier.then(async () => {
      this.assertActive(connectionId);
      const id = subscriptionId(params);
      const subscriptions = this.desired.get(connectionId);
      // Keep ownership until the guarded dispatch succeeds. If authority expires
      // while it waits, connection cleanup must still release the upstream lease.
      const result = this.isDesiredElsewhere(id, connectionId)
        ? { subscribed: false }
        : await gateway.request("sessions.messages.unsubscribe", params);
      subscriptions?.delete(id);
      if (subscriptions?.size === 0) {
        this.desired.delete(connectionId);
      }
      return result;
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

  private isDesiredElsewhere(id: string, excludedConnectionId?: string): boolean {
    for (const [connectionId, subscriptions] of this.desired) {
      if (connectionId !== excludedConnectionId && subscriptions.has(id)) {
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
