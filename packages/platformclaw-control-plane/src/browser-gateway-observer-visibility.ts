type BrowserGatewayObserverRpc = {
  request(method: string, params?: unknown): Promise<unknown>;
};

export class BrowserGatewayObserverVisibility {
  private readonly activeConnections = new Set<string>();
  private readonly visibleConnections = new Set<string>();
  private gatewayVisible: boolean | undefined = false;
  private gatewayGeneration = 0;
  private barrier = Promise.resolve();
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly gateway: BrowserGatewayObserverRpc,
    private readonly inactiveConnectionError: () => Error,
  ) {}

  registerConnection(connectionId: string): void {
    if (connectionId) {
      this.activeConnections.add(connectionId);
    }
  }

  handleGatewayDisconnect(): void {
    this.gatewayGeneration += 1;
    this.gatewayVisible = false;
    this.clearRetry();
  }

  async releaseConnection(connectionId: string): Promise<void> {
    if (!connectionId) {
      return;
    }
    // Mark the socket dead before queued RPC work runs. A visibility request
    // that is still resolving authentication must not resurrect this tab.
    this.activeConnections.delete(connectionId);
    // Desired membership changes synchronously. An already-queued retry must
    // observe the closed tab as absent before it can redeclare shared visibility.
    this.visibleConnections.delete(connectionId);
    try {
      await this.setConnectionVisibility(connectionId, false);
    } catch {
      // Reconciliation retains the desired aggregate and retries in the background.
    }
  }

  setConnectionVisibility(connectionId: string, visible: boolean): Promise<{ ok: true }> {
    const operation = this.barrier.then(async () => {
      if (visible) {
        if (!this.activeConnections.has(connectionId)) {
          throw this.inactiveConnectionError();
        }
        this.visibleConnections.add(connectionId);
      } else {
        this.visibleConnections.delete(connectionId);
      }
      await this.reconcile();
      return { ok: true } as const;
    });
    this.barrier = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async reconcile(): Promise<void> {
    const desiredGatewayVisibility = this.visibleConnections.size > 0;
    if (this.gatewayVisible === desiredGatewayVisibility) {
      this.clearRetry();
      return;
    }
    const generation = this.gatewayGeneration;
    try {
      await this.gateway.request("sessions.observer.visibility", {
        visible: desiredGatewayVisibility,
      });
    } catch (error) {
      if (generation === this.gatewayGeneration) {
        // A lost response is ambiguous: Gateway may have applied the request.
        // Force the next reconciliation to redeclare the complete desired state.
        this.gatewayVisible = undefined;
        this.scheduleRetry();
      }
      throw error;
    }
    if (generation !== this.gatewayGeneration) {
      return;
    }
    this.gatewayVisible = desiredGatewayVisibility;
    this.clearRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }
    // The shared private connection owns one aggregate declaration. Retry only
    // that desired state, with bounded backoff, so closed tabs cannot leak spend.
    const delayMs = Math.min(250 * 2 ** this.retryAttempt, 5_000);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const retry = this.barrier.then(() => this.reconcile());
      this.barrier = retry.then(
        () => undefined,
        () => undefined,
      );
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
