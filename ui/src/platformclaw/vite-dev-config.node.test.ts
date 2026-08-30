// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createPlatformClawDevConfig,
  resolvePlatformClawDevBackendOrigin,
  resolvePlatformClawDevRequestOrigin,
} from "../../vite.platformclaw-dev.config.ts";

describe("PlatformClaw Vite dev config", () => {
  it("uses the local control plane when no proxy target is supplied", () => {
    expect(resolvePlatformClawDevBackendOrigin(undefined)).toBe("http://127.0.0.1:19001");
  });

  it("accepts a team-provided HTTP(S) backend origin and rejects URL paths", () => {
    expect(resolvePlatformClawDevBackendOrigin("http://127.0.0.1:19443/")).toBe(
      "http://127.0.0.1:19443",
    );
    expect(() => resolvePlatformClawDevBackendOrigin("http://127.0.0.1:19443/path")).toThrow(
      "PLATFORMCLAW_DEV_BACKEND_URL must be an HTTP(S) origin",
    );
    expect(() => resolvePlatformClawDevBackendOrigin("ws://127.0.0.1:19443")).toThrow(
      "PLATFORMCLAW_DEV_BACKEND_URL must be an HTTP(S) origin",
    );
    expect(
      resolvePlatformClawDevRequestOrigin("http://127.0.0.1:19001", "http://localhost:5173"),
    ).toBe("http://localhost:5173");
    expect(() =>
      resolvePlatformClawDevRequestOrigin("http://127.0.0.1:19001", "ws://localhost"),
    ).toThrow("PLATFORMCLAW_DEV_REQUEST_ORIGIN must be an HTTP(S) origin");
  });

  it("keeps PlatformClaw routes on Vite while proxying backend APIs and the Gateway", () => {
    const config = createPlatformClawDevConfig("http://127.0.0.1:19001", "http://localhost:5173");
    expect(config.base).toBe("/");
    const proxy = config.server?.proxy as Record<string, { target?: string; ws?: boolean }>;
    expect(proxy["/platformclaw/api"]).toMatchObject({
      target: "http://127.0.0.1:19001",
    });
    expect(proxy["/platformclaw/gateway"]).toMatchObject({
      target: "http://127.0.0.1:19001",
      ws: true,
    });
    expect(proxy["/employee"]).toMatchObject({ target: "http://127.0.0.1:19001" });
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
