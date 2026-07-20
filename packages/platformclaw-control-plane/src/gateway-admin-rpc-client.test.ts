import { describe, expect, it, vi } from "vitest";
import { GatewayAdminRpcError, HttpGatewayAdminRpcClient } from "./gateway-admin-rpc-client.js";

function createClient(
  responder: (request: Record<string, unknown>) => { status?: number; body: unknown },
) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: "agents.list", params: {} });
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
