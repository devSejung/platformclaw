import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayAdminRpcError, HttpGatewayAdminRpcClient } from "./gateway-admin-rpc-client.js";

function parseJsonRequestBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error("expected a JSON string request body");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function createClient(
  responder: (request: Record<string, unknown>) => { status?: number; body: unknown },
) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = parseJsonRequestBody(init?.body);
    const response = responder(request);
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const client = new HttpGatewayAdminRpcClient(
    {
      rpcUrl: "http://127.0.0.1:18789/api/v1/admin/rpc",
      bearerToken: "test-bearer-token",
    },
    fetchImpl,
  );
  return { client, fetchImpl };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HttpGatewayAdminRpcClient", () => {
  it.each([0.5, 2 ** 32])(
    "rejects timeout values unsupported by AbortSignal.timeout: %s",
    (timeoutMs) => {
      expect(
        () =>
          new HttpGatewayAdminRpcClient({
            rpcUrl: "http://127.0.0.1:18789/api/v1/admin/rpc",
            bearerToken: "test-bearer-token",
            timeoutMs,
          }),
      ).toThrow("Gateway Admin RPC timeout must be an integer from 1 to 4294967295");
    },
  );

  it("sends one authenticated RPC request and returns its payload", async () => {
    const { client, fetchImpl } = createClient((request) => ({
      body: { id: request.id, ok: true, payload: { agents: [] } },
    }));

    await expect(client.call("agents.list", {})).resolves.toEqual({ agents: [] });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-bearer-token");
    expect(parseJsonRequestBody(init?.body)).toMatchObject({ method: "agents.list", params: {} });
  });

  it("gives bounded long-running SkillHub operations transport headroom", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { client } = createClient((request) => ({
      body: { id: request.id, ok: true, payload: {} },
    }));

    await client.call("agents.list", {});
    await client.call("skills.status", { refresh: true, backendTarget: "platform_server" });
    await client.call("skills.status", { refresh: true, backendTarget: "assigned_vm" });
    await client.call("skills.install", { source: "upload", destination: "sandbox-backend" });
    await client.call("skills.uninstall", { destination: "sandbox-backend" });

    expect(timeout.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
      15_000, 15_000, 30_000, 180_000, 180_000,
    ]);
  });

  it("preserves a longer operator-configured Admin RPC deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = parseJsonRequestBody(init?.body);
      return new Response(JSON.stringify({ id: request.id, ok: true, payload: {} }));
    });
    const client = new HttpGatewayAdminRpcClient(
      {
        rpcUrl: "http://127.0.0.1:18789/api/v1/admin/rpc",
        bearerToken: "test-bearer-token",
        timeoutMs: 240_000,
      },
      fetchImpl,
    );

    await client.call("skills.status", { refresh: true, backendTarget: "assigned_vm" });
    await client.call("skills.install", { source: "upload" });

    expect(timeout.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([240_000, 240_000]);
  });

  it("returns bounded Gateway errors without exposing response bodies", async () => {
    const { client } = createClient((request) => ({
      status: 400,
      body: {
        id: request.id,
        ok: false,
        error: { code: "INVALID_REQUEST", message: "agent already exists" },
      },
    }));

    await expect(client.call("agents.create", {})).rejects.toMatchObject({
      name: "GatewayAdminRpcError",
      code: "INVALID_REQUEST",
      httpStatus: 400,
      message: "agent already exists",
    });
  });

  it("fails closed when the response id does not match", async () => {
    const { client } = createClient(() => ({
      body: { id: "wrong-id", ok: true, payload: {} },
    }));

    await expect(client.call("agents.list", {})).rejects.toBeInstanceOf(GatewayAdminRpcError);
    await expect(client.call("agents.list", {})).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects a response whose declared size exceeds the byte limit", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{}"));
            },
            cancel,
          }),
          {
            headers: {
              "Content-Length": String(1024 * 1024 + 1),
              "Content-Type": "application/json",
            },
          },
        ),
    );
    const client = new HttpGatewayAdminRpcClient(
      {
        rpcUrl: "http://127.0.0.1:18789/api/v1/admin/rpc",
        bearerToken: "test-bearer-token",
      },
      fetchImpl,
    );

    await expect(client.call("agents.list", {})).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Gateway Admin RPC response exceeded the size limit",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stops reading a chunked response after the byte limit", async () => {
    const chunk = new Uint8Array(600 * 1024);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.close();
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const client = new HttpGatewayAdminRpcClient(
      {
        rpcUrl: "http://127.0.0.1:18789/api/v1/admin/rpc",
        bearerToken: "test-bearer-token",
      },
      fetchImpl,
    );

    await expect(client.call("agents.list", {})).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Gateway Admin RPC response exceeded the size limit",
    });
  });
});
