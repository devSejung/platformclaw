// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN,
  createPlatformClawDevConfig,
  resolvePlatformClawDevBackendOrigin,
  resolvePlatformClawDevRequestOrigin,
} from "../../vite.platformclaw-dev.config.ts";

describe("PlatformClaw Vite dev config", () => {
  it("uses the local control plane when no proxy target is supplied", () => {
    expect(resolvePlatformClawDevBackendOrigin(undefined)).toBe(
      DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN,
    );
  });

  it("accepts a team-provided HTTP(S) backend origin and rejects URL data", () => {
    const alternateOrigin = new URL(DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN);
    alternateOrigin.port = "19443";
    expect(resolvePlatformClawDevBackendOrigin(alternateOrigin.toString())).toBe(
      alternateOrigin.origin,
    );
    const pathOrigin = new URL(alternateOrigin);
    pathOrigin.pathname = "/path";
    expect(() => resolvePlatformClawDevBackendOrigin(pathOrigin.toString())).toThrow(
      "PLATFORMCLAW_DEV_BACKEND_URL must be an HTTP(S) origin",
    );
    const credentialOrigin = new URL(alternateOrigin);
    credentialOrigin.username = "user";
    credentialOrigin.password = "value";
    expect(() => resolvePlatformClawDevBackendOrigin(credentialOrigin.toString())).toThrow(
      "PLATFORMCLAW_DEV_BACKEND_URL must be an HTTP(S) origin",
    );
    const requestOrigin = new URL(DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN);
    requestOrigin.port = "15173";
    expect(
      resolvePlatformClawDevRequestOrigin(
        DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN,
        requestOrigin.toString(),
      ),
    ).toBe(requestOrigin.origin);
    const websocketOrigin = new URL(requestOrigin);
    websocketOrigin.protocol = "ws:";
    expect(() =>
      resolvePlatformClawDevRequestOrigin(
        DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN,
        websocketOrigin.toString(),
      ),
    ).toThrow("PLATFORMCLAW_DEV_REQUEST_ORIGIN must be an HTTP(S) origin");
  });

  it("keeps PlatformClaw routes on Vite while proxying backend APIs and the Gateway", () => {
    const requestOrigin = new URL(DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN);
    requestOrigin.port = "15173";
    const config = createPlatformClawDevConfig(
      DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN,
      requestOrigin.origin,
    );
    expect(config.base).toBe("/");
    const proxy = config.server?.proxy as Record<string, { target?: string; ws?: boolean }>;
    expect(proxy["/platformclaw/api"]).toMatchObject({
      target: DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN,
    });
    expect(proxy["/platformclaw/gateway"]).toMatchObject({
      target: DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN,
      ws: true,
    });
    expect(proxy["/employee"]).toMatchObject({ target: DEFAULT_PLATFORMCLAW_BACKEND_ORIGIN });
    const descriptorPlugin = config.plugins?.find(
      (plugin) =>
        !Array.isArray(plugin) &&
        plugin &&
        typeof plugin === "object" &&
        plugin.name === "platformclaw-dev-descriptor",
    );
    expect(descriptorPlugin).toBeDefined();
    const bootstrapConfigPlugin = config.plugins?.find(
      (plugin) =>
        !Array.isArray(plugin) &&
        plugin &&
        typeof plugin === "object" &&
        plugin.name === "platformclaw-dev-bootstrap-config",
    );
    expect(bootstrapConfigPlugin).toBeDefined();
  });
});
