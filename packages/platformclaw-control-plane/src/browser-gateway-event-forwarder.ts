import type { EventFrame } from "@openclaw/gateway-protocol";
import type { BrowserGatewayAccess, BrowserGatewayEvent } from "./browser-gateway-proxy.js";
import {
  PLATFORMCLAW_EXECUTION_CHANGED,
  type VmCredentialStateChange,
} from "./execution-contracts.js";

type BrowserGatewayEventProxy = {
  resolveAccess(token: string, touch?: boolean): Promise<BrowserGatewayAccess>;
  filterEvent(
    token: string,
    event: BrowserGatewayEvent,
    context?: { connectionId: string },
    access?: BrowserGatewayAccess,
  ): Promise<BrowserGatewayEvent | null>;
  filterConnectionEvent?(
    event: BrowserGatewayEvent,
    context?: { connectionId: string },
  ): BrowserGatewayEvent | null | undefined;
};

/** Upstream and browser-local events share one ordered browser sequence. */
export function createBrowserGatewayEventSender(
  send: (frame: EventFrame) => void,
): (event: BrowserGatewayEvent) => void {
  let sequence = 0;
  return (event) => {
    sequence += 1;
    send({
      type: "event",
      event: event.event,
      ...(event.payload === undefined ? {} : { payload: event.payload }),
      seq: sequence,
    });
  };
}

export function createBrowserGatewayEventForwarder(params: {
  connectionId: string;
  token: string;
  proxy: BrowserGatewayEventProxy;
  isConnected: () => boolean;
  sendEvent: (event: BrowserGatewayEvent) => void;
  closeUnauthorized: () => void;
}): (event: EventFrame) => Promise<void> {
  const context = { connectionId: params.connectionId };
  return async (event) => {
    if (!params.isConnected()) {
      return;
    }
    const connectionFiltered = params.proxy.filterConnectionEvent?.(event, context);
    if (connectionFiltered !== undefined) {
      if (connectionFiltered) {
        params.sendEvent(connectionFiltered);
      }
      return;
    }
    let access: BrowserGatewayAccess;
    try {
      // Event delivery validates without touching idle expiry; output is not user activity.
      access = await params.proxy.resolveAccess(params.token, false);
    } catch {
      params.closeUnauthorized();
      return;
    }
    const filtered = await params.proxy.filterEvent(params.token, event, context, access);
    if (filtered) {
      params.sendEvent(filtered);
    }
  };
}

/** Control-owned recovery notices never cross the upstream Gateway or another user's connection. */
export function createBrowserExecutionChangeForwarder(params: {
  token: string;
  proxy: Pick<BrowserGatewayEventProxy, "resolveAccess">;
  isConnected: () => boolean;
  sendEvent: (event: BrowserGatewayEvent) => void;
  closeUnauthorized: () => void;
}): (change: VmCredentialStateChange) => Promise<void> {
  return async (change) => {
    if (!params.isConnected()) {
      return;
    }
    let access: BrowserGatewayAccess;
    try {
      access = await params.proxy.resolveAccess(params.token, false);
    } catch {
      params.closeUnauthorized();
      return;
    }
    // Resolve current authority after the notification was queued. A handshake's
    // agent identity cannot authorize delivery after logout or binding replacement.
    if (!params.isConnected() || access.binding.agentId !== change.agentId) {
      return;
    }
    params.sendEvent({
      event: PLATFORMCLAW_EXECUTION_CHANGED,
      payload: {
        agentId: change.agentId,
        allocationId: change.allocationId,
        targetRevision: change.targetRevision,
        credentialRevision: change.credentialRevision,
        status: change.status,
      },
    });
  };
}
