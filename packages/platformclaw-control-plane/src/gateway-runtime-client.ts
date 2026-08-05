import {
  GatewayClient,
  GatewayClientRequestError,
  type GatewayClientOptions,
} from "@openclaw/gateway-client";
import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
  readPairingConnectErrorDetails,
} from "@openclaw/gateway-protocol/connect-error-details";
import type { BrowserGatewayRpc } from "./browser-gateway-proxy.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import {
  createGatewayServiceHostDeps,
  type GatewayServiceIdentity,
} from "./gateway-service-identity.js";

// The private service client—not the browser projection—must attach trusted
// chat provenance controls required by Gateway. Browser requests remain
// constrained by BrowserGatewayProxy and its read/write hello projection.
const REQUIRED_SERVICE_SCOPES = ["operator.read", "operator.write", "operator.admin"] as const;
const MAX_AUTOMATIC_PAIRING_RESTARTS = 2;
const SESSION_SUBSCRIPTION_RETRY_BASE_MS = 250;
const SESSION_SUBSCRIPTION_RETRY_MAX_MS = 5_000;

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
  pairing?: {
    adminRpc: GatewayAdminRpc;
    identity: GatewayServiceIdentity;
  };
};

type PendingDevicePairing = {
  requestId: string;
  deviceId: string;
  publicKey: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  scopes?: string[];
};

type DevicePairingList = { pending: PendingDevicePairing[] };

function sameStringSet(
  actual: readonly string[] | undefined,
  expected: readonly string[],
): boolean {
  return actual?.length === expected.length && expected.every((value) => actual.includes(value));
}

function hasRequiredServiceScopes(hello: HelloOk): boolean {
  const scopes = hello.auth?.scopes ?? [];
  return REQUIRED_SERVICE_SCOPES.every((scope) => scopes.includes(scope));
}

/** Owns the single private operator connection shared by browser ingress sessions. */
export class PlatformClawGatewayRuntimeClient implements PlatformClawGatewayBackend {
  private readonly client: GatewayClientLike;
  private readonly listeners = new Set<(event: EventFrame) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private hello: HelloOk | null = null;
  private connectionEpoch = 0;
  private pairingAttempt: Promise<boolean> | null = null;
  private pairingRetryCount = 0;

  constructor(options: PlatformClawGatewayRuntimeClientOptions) {
    const createClient =
      options.createClient ?? ((clientOptions) => new GatewayClient(clientOptions));
    const configuredOnEvent = options.client.onEvent;
    const configuredOnHello = options.client.onHelloOk;
    const configuredOnClose = options.client.onClose;
    this.client = createClient({
      ...options.client,
      ...(options.pairing
        ? { hostDeps: createGatewayServiceHostDeps(options.pairing.identity) }
        : {}),
      onEvent: (event) => {
        configuredOnEvent?.(event);
        for (const listener of this.listeners) {
          listener(event);
        }
      },
      onHelloOk: (hello) => {
        const epoch = ++this.connectionEpoch;
        this.hello = null;
        if (hasRequiredServiceScopes(hello)) {
          void this.activateSessionEvents(hello, epoch, options.client.onConnectError);
        }
        configuredOnHello?.(hello);
      },
      onConnectError: (error) => {
        options.client.onConnectError?.(error);
        if (options.pairing && this.isPairingRequired(error) && !this.pairingAttempt) {
          const attempt = this.approveServicePairing(options.pairing, error).then(
            () => true,
            (pairingError: unknown) => {
              options.client.onConnectError?.(
                pairingError instanceof Error
                  ? pairingError
                  : new Error("Gateway service pairing failed"),
              );
              return false;
            },
          );
          this.pairingAttempt = attempt;
          void attempt.finally(() => {
            if (this.pairingAttempt === attempt) {
              this.pairingAttempt = null;
            }
          });
        }
      },
      onReconnectPaused: (info) => {
        options.client.onReconnectPaused?.(info);
        if (info.detailCode === ConnectErrorDetailCodes.PAIRING_REQUIRED) {
          void this.pairingAttempt?.then(() => {
            if (this.pairingRetryCount < MAX_AUTOMATIC_PAIRING_RESTARTS) {
              this.pairingRetryCount += 1;
              this.client.start();
            }
          });
        }
      },
      onClose: (code, reason, info) => {
        this.connectionEpoch += 1;
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
    this.connectionEpoch += 1;
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

  private async activateSessionEvents(
    hello: HelloOk,
    epoch: number,
    reportError: ((error: Error) => void) | undefined,
    attempt = 0,
  ): Promise<void> {
    try {
      const result = await this.client.request("sessions.subscribe", {});
      if (epoch !== this.connectionEpoch) {
        return;
      }
      if (
        !result ||
        typeof result !== "object" ||
        (result as { subscribed?: unknown }).subscribed !== true
      ) {
        throw new Error("Gateway session event subscription was not acknowledged");
      }
      this.hello = hello;
      this.pairingRetryCount = 0;
    } catch (error) {
      if (epoch !== this.connectionEpoch) {
        return;
      }
      reportError?.(
        error instanceof Error ? error : new Error("Gateway session event subscription failed"),
      );
      const delayMs = Math.min(
        SESSION_SUBSCRIPTION_RETRY_BASE_MS * 2 ** Math.min(attempt, 5),
        SESSION_SUBSCRIPTION_RETRY_MAX_MS,
      );
      setTimeout(() => {
        if (epoch === this.connectionEpoch) {
          void this.activateSessionEvents(hello, epoch, reportError, attempt + 1);
        }
      }, delayMs);
    }
  }

  private isPairingRequired(error: Error): error is GatewayClientRequestError {
    return (
      error instanceof GatewayClientRequestError &&
      readConnectErrorDetailCode(error.details) === ConnectErrorDetailCodes.PAIRING_REQUIRED
    );
  }

  private async approveServicePairing(
    pairing: NonNullable<PlatformClawGatewayRuntimeClientOptions["pairing"]>,
    error: GatewayClientRequestError,
  ): Promise<void> {
    const details = readPairingConnectErrorDetails(error.details);
    if (
      details?.reason !== "not-paired" ||
      !details.requestId ||
      details.deviceId !== pairing.identity.deviceId ||
      details.requestedRole !== "operator" ||
      !sameStringSet(details.requestedScopes, REQUIRED_SERVICE_SCOPES)
    ) {
      throw new Error("Gateway service pairing details did not match the configured identity");
    }

    const list = await pairing.adminRpc.call<DevicePairingList>("device.pair.list", {});
    const matches = list.pending.filter(
      (pending) =>
        pending.requestId === details.requestId &&
        pending.deviceId === pairing.identity.deviceId &&
        pending.publicKey === pairing.identity.publicKeyRawBase64Url &&
        pending.clientId === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT &&
        pending.clientMode === GATEWAY_CLIENT_MODES.BACKEND &&
        pending.role === "operator" &&
        sameStringSet(pending.scopes, REQUIRED_SERVICE_SCOPES),
    );
    if (matches.length !== 1) {
      throw new Error("Gateway service pairing request was missing or ambiguous");
    }
    await pairing.adminRpc.call("device.pair.approve", { requestId: details.requestId });
  }
}
