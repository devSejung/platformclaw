import { GatewayClient, type GatewayClientOptions } from "@openclaw/gateway-client";
import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol";
import type { BrowserGatewayRpc } from "./browser-gateway-proxy.js";

export type PlatformClawGatewayBackend = BrowserGatewayRpc & {
  start(): void;
  stop(): void;
  getHello(): HelloOk | null;
  subscribe(listener: (event: EventFrame) => void): () => void;
  subscribeDisconnect(listener: () => void): () => void;
};

type GatewayClientLike = {
  start(): void;
  stop(): void;
  request(method: string, params?: unknown): Promise<unknown>;
};

export type PlatformClawGatewayRuntimeClientOptions = {
  client: GatewayClientOptions;
  createClient?: (options: GatewayClientOptions) => GatewayClientLike;
};

/** Owns the single private operator connection shared by browser ingress sessions. */
export class PlatformClawGatewayRuntimeClient implements PlatformClawGatewayBackend {
  private readonly client: GatewayClientLike;
  private readonly listeners = new Set<(event: EventFrame) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private hello: HelloOk | null = null;

  constructor(options: PlatformClawGatewayRuntimeClientOptions) {
    const createClient =
      options.createClient ?? ((clientOptions) => new GatewayClient(clientOptions));
    const configuredOnEvent = options.client.onEvent;
    const configuredOnHello = options.client.onHelloOk;
    const configuredOnClose = options.client.onClose;
    this.client = createClient({
      ...options.client,
      onEvent: (event) => {
        configuredOnEvent?.(event);
        for (const listener of this.listeners) {
          listener(event);
        }
      },
      onHelloOk: (hello) => {
        this.hello = hello;
        configuredOnHello?.(hello);
      },
      onClose: (code, reason, info) => {
        this.hello = null;
        for (const listener of this.disconnectListeners) {
          listener();
        }
        configuredOnClose?.(code, reason, info);
      },
    });
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.hello = null;
    this.client.stop();
  }

  getHello(): HelloOk | null {
    return this.hello;
  }

  subscribe(listener: (event: EventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.hello) {
      throw new Error("private Gateway connection is unavailable");
    }
    return (await this.client.request(method, params)) as T;
  }
}
