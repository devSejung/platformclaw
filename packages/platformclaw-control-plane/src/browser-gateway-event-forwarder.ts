import type { EventFrame } from "@openclaw/gateway-protocol";
import type { BrowserGatewayAccess, BrowserGatewayEvent } from "./browser-gateway-proxy.js";

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
