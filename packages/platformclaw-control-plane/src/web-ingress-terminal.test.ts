import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { BrowserAuthService } from "./browser-auth-service.js";
import { NOW, setupBrowserGatewayProxyTest } from "./browser-gateway-proxy.test-harness.js";
import { PlatformClawWebIngressServer } from "./web-ingress-server.js";
import {
  createFrameQueue,
  deferred,
  FakeGateway,
  isRecord,
  upstreamHello,
} from "./web-ingress-test-harness.js";
const PUBLIC_ORIGIN = "https://platformclaw.example";
describe("PlatformClaw terminal WebSocket ownership", () => {
  let server: PlatformClawWebIngressServer | undefined;
  let websocket: WebSocket | undefined;
  afterEach(async () => {
    websocket?.terminate();
    websocket = undefined;
    await server?.close();
    server = undefined;
  });
  it("delivers browser takeover and denies an old close across real WebSocket connections", async () => {
    const { binding, proxy, request, store, token } = await setupBrowserGatewayProxyTest();
    vi.spyOn(store, "getPersonalExecutionProfile").mockResolvedValue({
      agentBindingId: binding.id,
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 7,
      updatedAt: NOW,
    });
    const terminal = {
      sessionId: "wire-terminal",
      agentId: binding.agentId,
      confined: true,
      shell: "login shell",
      cwd: "/home/person_one",
      buffer: "",
      seq: 0,
    };
    const takeover = deferred<unknown>();
    let attachmentCount = 0;
    request.mockImplementation(async (method) => {
      if (method === "terminal.open") {
        return terminal;
      }
      if (method === "terminal.attach") {
        return ++attachmentCount === 1 ? terminal : takeover.promise;
      }
      return {};
    });
    const localSubscriptions = new Set<string>();
    const subscribe = proxy.subscribeConnectionEvents.bind(proxy);
    vi.spyOn(proxy, "subscribeConnectionEvents").mockImplementation((connectionId, listener) => {
      localSubscriptions.add(connectionId);
      const unsubscribe = subscribe(connectionId, listener);
      return () => {
        unsubscribe();
        localSubscriptions.delete(connectionId);
      };
    });
    const browserRequest = vi.spyOn(proxy, "request");
    const release = vi.spyOn(proxy, "releaseBrowserConnection");
    const gateway = new FakeGateway();
    vi.spyOn(gateway, "getHello").mockImplementation(() => {
      const hello = upstreamHello();
      hello.features.methods.push(
        "terminal.open",
        "terminal.attach",
        "terminal.input",
        "terminal.close",
        "terminal.resize",
        "terminal.list",
      );
      hello.features.events.push("terminal.data", "terminal.exit");
      return hello;
    });
    server = new PlatformClawWebIngressServer({
      publicOrigin: PUBLIC_ORIGIN,
      authService: {} as BrowserAuthService,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: vi.fn(),
      },
      gatewayProxy: proxy,
      gateway,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as AddressInfo).port;
    const connect = async (id: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
        origin: PUBLIC_ORIGIN,
        headers: { Cookie: `platformclaw_session=${token}` },
      });
      const nextFrame = createFrameQueue(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await nextFrame((frame) => isRecord(frame) && frame.event === "connect.challenge");
      const rpc = (requestId: string, method: string, params: unknown) => {
        socket.send(JSON.stringify({ type: "req", id: requestId, method, params }));
        return nextFrame((frame) => isRecord(frame) && frame.id === requestId);
      };
      await expect(
        rpc(id, "connect", {
          minProtocol: 4,
          maxProtocol: 4,
          client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
        }),
      ).resolves.toMatchObject({ ok: true });
      return { socket, rpc, nextFrame };
    };
    const first = await connect("connect-a");
    websocket = first.socket;
    let second: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      second = await connect("connect-b");
      expect(localSubscriptions.size).toBe(2);
      await expect(
        first.rpc("open-a", "terminal.open", { cols: 80, rows: 24 }),
      ).resolves.toMatchObject({ ok: true, payload: { sessionId: terminal.sessionId } });
      const attached = second.rpc("attach-b", "terminal.attach", { sessionId: terminal.sessionId });
      await vi.waitFor(() => expect(attachmentCount).toBe(2));
      const oldClose = first.rpc("old-close", "terminal.close", { sessionId: terminal.sessionId });
      await vi.waitFor(() =>
        expect(browserRequest.mock.calls.some((call) => call[1] === "terminal.close")).toBe(true),
      );
      expect(request).not.toHaveBeenCalledWith("terminal.close", expect.anything());
      takeover.resolve(terminal);
      await expect(attached).resolves.toMatchObject({ ok: true });
      await expect(
        first.nextFrame((frame) => isRecord(frame) && frame.event === "terminal.exit"),
      ).resolves.toMatchObject({
        type: "event",
        payload: { sessionId: terminal.sessionId, reason: "detached" },
      });
      await expect(oldClose).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      await expect(
        first.rpc("old-input", "terminal.input", { sessionId: terminal.sessionId, data: "old" }),
      ).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      await expect(
        second.rpc("new-input", "terminal.input", { sessionId: terminal.sessionId, data: "new" }),
      ).resolves.toMatchObject({ ok: true });
      expect(request).toHaveBeenCalledWith("terminal.input", {
        sessionId: terminal.sessionId,
        data: "new",
      });
      first.socket.close();
      await vi.waitFor(() => expect(localSubscriptions.size).toBe(1));
      expect(release).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveBeenCalledWith("terminal.close", expect.anything());
      second.socket.close();
      await vi.waitFor(() => expect(localSubscriptions.size).toBe(0));
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      second?.socket.terminate();
      await proxy.closeTerminalsForAgent(binding.agentId, "test_cleanup");
    }
  });
});
