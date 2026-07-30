import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handlePlatformClawKnoxIngressProxy,
  PLATFORMCLAW_KNOX_INBOUND_PATH,
} from "./knox-ingress-proxy.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("handlePlatformClawKnoxIngressProxy", () => {
  it("preserves signed body bytes and authentication headers", async () => {
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(Buffer.from(init?.body as Buffer).toString("utf8")).toBe('{"text":"hello"}');
      expect(init?.headers).toMatchObject({
        "x-platformclaw-timestamp": "1785456000000",
        "x-platformclaw-signature": `sha256=${"a".repeat(64)}`,
      });
      return new Response('{"ok":true}', {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    });
    const server = createServer((req, res) => {
      void handlePlatformClawKnoxIngressProxy(req, res, {
        targetUrl: `http://gateway.test${PLATFORMCLAW_KNOX_INBOUND_PATH}`,
        fetchImpl: upstream,
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind TCP");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}${PLATFORMCLAW_KNOX_INBOUND_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-platformclaw-timestamp": "1785456000000",
          "x-platformclaw-signature": `sha256=${"a".repeat(64)}`,
        },
        body: '{"text":"hello"}',
      },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("maps a missing private Gateway route to retryable service unavailable", async () => {
    const server = createServer((req, res) => {
      void handlePlatformClawKnoxIngressProxy(req, res, {
        targetUrl: `http://gateway.test${PLATFORMCLAW_KNOX_INBOUND_PATH}`,
        fetchImpl: async () => new Response("not found", { status: 404 }),
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind TCP");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}${PLATFORMCLAW_KNOX_INBOUND_PATH}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "knox_gateway_unavailable",
    });
  });
});
