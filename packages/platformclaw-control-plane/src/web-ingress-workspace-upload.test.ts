import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { BrowserAuthService } from "./browser-auth-service.js";
import { NOW, setupBrowserGatewayProxyTest } from "./browser-gateway-proxy.test-harness.js";
import { PlatformClawWebIngressServer } from "./web-ingress-server.js";
import {
  createFrameQueue,
  FakeGateway,
  isRecord,
  upstreamHello,
} from "./web-ingress-test-harness.js";

describe("workspace upload across the browser WebSocket boundary", () => {
  let server: PlatformClawWebIngressServer | undefined;
  let socket: WebSocket | undefined;

  afterEach(async () => {
    socket?.terminate();
    socket = undefined;
    await server?.close();
    server = undefined;
  });

  it("advertises upload for members, forwards owned bytes, and rejects foreign sessions and stale VM controls", async () => {
    const f = await setupBrowserGatewayProxyTest();
    const gateway = new FakeGateway();
    vi.spyOn(gateway, "getHello").mockImplementation(() => {
      const hello = upstreamHello();
      hello.features.methods.push("sessions.files.upload");
      return hello;
    });
    f.request.mockImplementation(async (_method, raw) => {
      const params = raw as {
        sessionKey: string;
        path: string;
        name: string;
        contentBase64: string;
      };
      return {
        sessionKey: params.sessionKey,
        path: `${params.path}/${params.name}`,
        size: Buffer.from(params.contentBase64, "base64").length,
      };
    });
    const origin = "https://platformclaw.example";
    server = new PlatformClawWebIngressServer({
      publicOrigin: origin,
      authService: {} as BrowserAuthService,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: vi.fn(),
      },
      gatewayProxy: f.proxy,
      gateway,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    socket = new WebSocket(
      `ws://127.0.0.1:${(server.address() as AddressInfo).port}/platformclaw/gateway`,
      {
        origin,
        headers: { Cookie: `platformclaw_session=${f.token}` },
      },
    );
    const nextFrame = createFrameQueue(socket);
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    await nextFrame((frame) => isRecord(frame) && frame.event === "connect.challenge");
    const rpc = (id: string, method: string, params: unknown) => {
      socket!.send(JSON.stringify({ type: "req", id, method, params }));
      return nextFrame((frame) => isRecord(frame) && frame.id === id);
    };
    const connected = await rpc("connect", "connect", {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
    });
    expect(connected).toMatchObject({
      ok: true,
      payload: { features: { methods: expect.arrayContaining(["sessions.files.upload"]) } },
    });
    const params = {
      sessionKey: `agent:${f.binding.agentId}:main`,
      path: "reports",
      name: "sample.bin",
      contentBase64: "AP8B",
    };
    await expect(rpc("save", "sessions.files.upload", params)).resolves.toMatchObject({
      ok: true,
      payload: { sessionKey: params.sessionKey, path: "reports/sample.bin", size: 3 },
    });
    expect(f.request).toHaveBeenCalledWith("sessions.files.upload", {
      ...params,
      agentId: f.binding.agentId,
    });
    await expect(
      rpc("foreign", "sessions.files.upload", { ...params, sessionKey: "agent:other:main" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    vi.spyOn(f.store, "getPersonalExecutionProfile").mockResolvedValue({
      agentBindingId: f.binding.id,
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 2,
      updatedAt: NOW,
    });
    await expect(rpc("vm", "sessions.files.upload", params)).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
