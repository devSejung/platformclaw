import type { GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/context.ts";

/** Owns the subscriptions and employee identity of one mounted Spaces surface. */
export class SpaceGatewayLifetime {
  connected = false;
  userId: string | undefined;
  private source: ApplicationGateway | undefined;
  private client: ApplicationGateway["snapshot"]["client"] | undefined;
  private unsubscribeState: (() => void) | undefined;
  private unsubscribeEvents: (() => void) | undefined;

  constructor(
    private readonly changed: () => void,
    private readonly onEvent: (event: GatewayEventFrame) => void,
  ) {}

  update(source: ApplicationGateway): "identity" | "reconnected" | "disconnected" | null {
    const wasConnected = this.connected;
    this.connected = source.snapshot.phase === "connected";
    const sourceChanged = this.source !== source;
    const identityChanged = this.connected && this.userId !== source.snapshot.selfUser?.id;
    if (this.connected) {
      this.userId = source.snapshot.selfUser?.id;
    }
    if (sourceChanged) {
      this.unsubscribeState?.();
      this.source = source;
      this.unsubscribeState = source.subscribe(this.changed);
    }
    if (sourceChanged || identityChanged || this.client !== source.snapshot.client) {
      this.client = source.snapshot.client;
      this.unsubscribeEvents?.();
      this.unsubscribeEvents = source.subscribeEvents(this.onEvent);
      return "identity";
    }
    return this.connected === wasConnected ? null : this.connected ? "reconnected" : "disconnected";
  }

  dispose() {
    this.unsubscribeState?.();
    this.unsubscribeEvents?.();
    this.unsubscribeState = this.unsubscribeEvents = undefined;
    this.source = undefined;
    this.client = undefined;
    this.userId = undefined;
    this.connected = false;
  }
}
