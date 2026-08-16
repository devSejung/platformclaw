import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrowserGatewayAccess, BrowserGatewayEvent } from "./browser-gateway-proxy.js";

export type PlatformClawBrowserGatewayPolicy = {
  resolveAccess(token: string, touch?: boolean): Promise<BrowserGatewayAccess>;
  registerBrowserConnection?(connectionId: string, access?: BrowserGatewayAccess): void;
  request(
    token: string,
    method: string,
    params?: unknown,
    context?: { connectionId: string },
  ): Promise<unknown>;
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
  handleGatewayDisconnect?(): void;
  releaseBrowserConnection?(connectionId: string): Promise<void>;
};

export type PlatformClawBrowserMediaRelay = {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
};

export type PlatformClawBrowserCanvasRelay = {
  issueSurface(access: BrowserGatewayAccess): {
    pluginSurfaceUrls: { canvas: string };
    expiresAtMs: number;
  };
  refresh(token: string, params: unknown): Promise<unknown>;
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
};
