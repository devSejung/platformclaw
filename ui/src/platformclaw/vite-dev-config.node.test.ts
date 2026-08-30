// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createPlatformClawDevConfig,
  resolvePlatformClawDevBackendOrigin,
  resolvePlatformClawDevRequestOrigin,
} from "../../vite.platformclaw-dev.config.ts";

describe("PlatformClaw Vite dev config", () => {
  it("uses the local control plane when no proxy target is supplied", () => {
    expect(resolvePlatformClawDevBackendOrigin(undefined)).toMatch(/:19001$/);
  });

  it("accepts a team-provided HTTP(S) backend origin and rejects URL paths", () => {
    const backendOrigin = resolvePlatformClawDevBackendOrigin();
    expect(resolvePlatformClawDevBackendOrigin(`${backendOrigin}/`)).toBe(backendOrigin);
    expect(() => resolvePlatformClawDevBackendOrigin(`${backendOrigin}/path`)).toThrow(
      "PLATFORMCLAW_DEV_BACKEND_URL must be an HTTP(S) origin",
    );
    expect(() => resolvePlatformClawDevBackendOrigin("ws")).toThrow(
      "PLATFORMCLAW_DEV_BACKEND_URL must be an HTTP(S) origin",
    );
    expect(resolvePlatformClawDevRequestOrigin(backendOrigin)).toBe(backendOrigin);
    expect(() => resolvePlatformClawDevRequestOrigin(backendOrigin, "ws")).toThrow(
      "PLATFORMCLAW_DEV_REQUEST_ORIGIN must be an HTTP(S) origin",
    );
  });

  it("keeps PlatformClaw routes on Vite while proxying backend APIs and the Gateway", () => {
    const backendOrigin = resolvePlatformClawDevBackendOrigin();
    const config = createPlatformClawDevConfig(backendOrigin, backendOrigin);
    expect(config.base).toBe("/");
    const proxy = config.server?.proxy as Record<string, { target?: string; ws?: boolean }>;
    expect(proxy["/platformclaw/api"]).toMatchObject({
      target: backendOrigin,
    });
    expect(proxy["/platformclaw/gateway"]).toMatchObject({
      target: backendOrigin,
      ws: true,
    });
    expect(proxy["/employee"]).toMatchObject({ target: backendOrigin });
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
