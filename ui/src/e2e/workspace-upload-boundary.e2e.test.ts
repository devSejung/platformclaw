import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import {
  validateRequestFrame,
  type RequestFrame,
} from "../../../packages/gateway-protocol/src/index.js";
import { MAX_TERMINAL_UPLOAD_BYTES } from "../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import { PLATFORMCLAW_SESSION_COOKIE } from "../../../packages/platformclaw-control-plane/src/browser-auth-http.js";
import { BrowserAuthService } from "../../../packages/platformclaw-control-plane/src/browser-auth-service.js";
import { BrowserGatewayProxy } from "../../../packages/platformclaw-control-plane/src/browser-gateway-proxy.js";
import {
  NOW,
  setupBrowserGatewayProxyTest,
} from "../../../packages/platformclaw-control-plane/src/browser-gateway-proxy.test-harness.js";
import { PlatformClawGatewayRuntimeClient } from "../../../packages/platformclaw-control-plane/src/gateway-runtime-client.js";
import { PlatformClawWebIngressServer } from "../../../packages/platformclaw-control-plane/src/web-ingress-server.js";
import { upstreamHello } from "../../../packages/platformclaw-control-plane/src/web-ingress-test-harness.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-contract.js";
import { MAX_PAYLOAD_BYTES } from "../../../src/gateway/server-constants.js";
import { sessionsFilesUploadHandlers } from "../../../src/gateway/server-methods/sessions-files-upload.js";
import type {
  GatewayRequestContext,
  RespondFn,
} from "../../../src/gateway/server-methods/types.js";
import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import { createControlUiMockBootstrapConfig } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const fixture = vi.hoisted(() => ({ loadRoot: vi.fn() }));
// Session discovery/auth are synthetic. Both WebSocket hops, the BFF, clients,
// upload handler and filesystem creation are real; this is payload-size proof.
vi.mock("../../../src/gateway/server-methods/sessions-file-root.js", () => ({
  loadSessionFileRoot: fixture.loadRoot,
}));

function decodeFrame(data: RawData): string {
  return Buffer.isBuffer(data)
    ? data.toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : Buffer.concat(data).toString("utf8");
}

const suite = createControlUiE2eSuite({
  name: "Workspace upload public and private WebSocket size boundary",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("saves exactly 16 MiB through the real browser, BFF and private Gateway wire path", async () => {
    const tempRoot = await realpath(os.tmpdir());
    const root = await mkdtemp(path.join(tempRoot, "platformclaw-upload-wire-boundary-"));
    const f = await setupBrowserGatewayProxyTest();
    const agentId = f.binding.agentId;
    const sessionKey = `agent:${agentId}:main`;
    fixture.loadRoot.mockReturnValue({
      root,
      agentId,
      canonicalKey: sessionKey,
      entry: { sessionId: "synthetic-wire-upload" },
    });
    const privateServer = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    await once(privateServer, "listening");
    const privateAddress = privateServer.address() as AddressInfo;
    const privateRequests: Array<{
      method: string;
      frameBytes: number;
      params: Record<string, unknown>;
    }> = [];
    const privateErrors: string[] = [];
    const hello = upstreamHello();
    hello.features.methods = [
      "agents.list",
      "agent.identity.get",
      "sessions.list",
      "sessions.subscribe",
      "chat.history",
      "models.list",
      "sessions.files.list",
      "sessions.files.get",
      "sessions.files.upload",
    ];
    hello.policy.maxPayload = MAX_PAYLOAD_BYTES;
    hello.policy.maxBufferedBytes = MAX_PAYLOAD_BYTES;
    const agentsList = {
      defaultId: agentId,
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: agentId, name: "Synthetic workspace" }],
    };

    async function dispatch(
      frame: RequestFrame,
      frameBytes: number,
      send: (response: unknown) => void,
    ) {
      const params =
        frame.params && typeof frame.params === "object" && !Array.isArray(frame.params)
          ? (frame.params as Record<string, unknown>)
          : {};
      const { contentBase64, ...safeParams } = params;
      privateRequests.push({
        method: frame.method,
        frameBytes,
        params: {
          ...safeParams,
          ...(typeof contentBase64 === "string" ? { encodedLength: contentBase64.length } : {}),
        },
      });
      const respond: RespondFn = (ok, payload, error) =>
        send({ type: "res", id: frame.id, ok, payload, error });
      if (frame.method === "sessions.files.upload") {
        expect(params).toMatchObject({ agentId, sessionKey, path: "", name: "limit-16MiB.bin" });
        const handler = sessionsFilesUploadHandlers[frame.method];
        if (!handler) {
          throw new Error("Workspace upload handler is unavailable");
        }
        await handler({
          req: frame,
          params,
          client: null,
          context: {} as GatewayRequestContext,
          respond,
          isWebchatConnect: () => false,
        });
        return;
      }
      let payload: unknown;
      switch (frame.method) {
        case "connect":
          expect(params.auth).toMatchObject({ token: "<REDACTED_CREDENTIAL_003>" });
          payload = hello;
          break;
        case "sessions.subscribe":
          payload = { subscribed: true };
          break;
        case "agents.list":
          payload = agentsList;
          break;
        case "agent.identity.get":
          payload = { agentId, name: "Synthetic workspace", avatar: "" };
          break;
        case "sessions.list":
          payload = {
            ts: Date.now(),
            count: 1,
            defaults: {},
            sessions: [{ key: sessionKey, agentId, updatedAt: Date.now() }],
          };
          break;
        case "chat.history":
          payload = { sessionKey, sessionId: "synthetic-wire-upload", messages: [] };
          break;
        case "models.list":
          payload = { models: [] };
          break;
        case "sessions.files.list": {
          const entries = await readdir(root, { withFileTypes: true });
          payload = {
            sessionKey,
            root,
            files: [],
            uploadAllowed: true,
            browser: {
              path: "",
              entries: entries.map((entry) => ({
                kind: entry.isDirectory() ? "directory" : "file",
                name: entry.name,
                path: entry.name,
              })),
            },
          };
          break;
        }
        case "sessions.files.get":
          payload = null;
          break;
        default:
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "Unsupported synthetic read fixture",
          });
          return;
      }
      respond(true, payload);
    }

    privateServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const text = decodeFrame(data);
        const frame: unknown = JSON.parse(text);
        if (!validateRequestFrame(frame)) {
          privateErrors.push("Invalid private Gateway request frame");
          socket.close(1008, "invalid synthetic request");
          return;
        }
        void dispatch(frame, Buffer.byteLength(text), (response) =>
          socket.send(JSON.stringify(response)),
        ).catch((error: unknown) => {
          privateErrors.push(error instanceof Error ? error.message : String(error));
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "UNAVAILABLE", message: "Synthetic dispatcher failed" },
            }),
          );
        });
      });
      socket.on("error", (error) => privateErrors.push(error.message));
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "synthetic-upload-boundary", ts: Date.now() },
        }),
      );
    });

    const backend = new PlatformClawGatewayRuntimeClient({
      client: {
        url: `ws://127.0.0.1:${privateAddress.port}`,
        token: "<REDACTED_CREDENTIAL_003>",
        deviceIdentity: null,
        onConnectError: (error) => privateErrors.push(error.message),
      },
    });
    const authService = new BrowserAuthService({
      store: f.store,
      authenticator: {
        async authenticatePassword() {
          return { status: "rejected" as const, message: "unused" };
        },
      },
      provisioner: { async provisionOrRefresh() {} },
      now: () => NOW,
    });
    const proxy = new BrowserGatewayProxy({
      authService,
      store: f.store,
      auditWriter: f.auditWriter,
      gateway: backend,
      buildAgentMainSessionKey: ({ agentId: id }) => `agent:${id}:main`,
      resolveAgentIdFromSessionKey: (key) => parseAgentSessionKey(key)?.agentId ?? null,
      now: () => NOW,
    });
    const ingress = new PlatformClawWebIngressServer({
      publicOrigin: new URL(suite.server.baseUrl).origin,
      authService,
      gatewayProxy: proxy,
      gateway: backend,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: () => {},
      },
    });
    const context = await suite.newBrowserContext({
      serviceWorkers: "block",
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    let uploadRequestId: string | undefined;
    let publicFrameBytes: number | undefined;
    let publicUploadParams: Record<string, unknown> | undefined;
    let publicUploadResult: unknown;
    let browserHello: Record<string, unknown> | undefined;
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        if (typeof payload !== "string") {
          return;
        }
        const frame = JSON.parse(payload) as RequestFrame;
        if (frame.method === "sessions.files.upload") {
          uploadRequestId = frame.id;
          publicFrameBytes = Buffer.byteLength(payload);
          const { contentBase64, ...params } = frame.params as Record<string, unknown>;
          publicUploadParams = {
            ...params,
            encodedLength: typeof contentBase64 === "string" ? contentBase64.length : 0,
          };
        }
      });
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") {
          return;
        }
        const frame = JSON.parse(payload) as {
          id?: string;
          type?: string;
          ok?: boolean;
          payload?: Record<string, unknown>;
        };
        if (frame.payload?.type === "hello-ok") {
          browserHello = frame.payload;
        }
        if (frame.id === uploadRequestId && frame.type === "res") {
          publicUploadResult = frame;
        }
      });
    });

    try {
      backend.start();
      await expect.poll(() => backend.getHello() !== null, { timeout: 15_000 }).toBe(true);
      await ingress.listen({ host: "127.0.0.1", port: 0 });
      const publicPort = (ingress.address() as AddressInfo).port;
      const gatewayUrl = `ws://127.0.0.1:${publicPort}/platformclaw/gateway`;
      await context.addCookies([
        {
          name: PLATFORMCLAW_SESSION_COOKIE,
          value: f.token,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
        route.fulfill({
          json: createControlUiMockBootstrapConfig({
            defaultAgentId: agentId,
            assistantAgentId: agentId,
            assistantName: "Synthetic workspace",
            sessionKey,
          }),
        }),
      );
      await page.addInitScript(
        ({ gatewayUrl: url }) => {
          (
            window as Window & {
              ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
            }
          )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
            gatewayUrl: url,
            token: "synthetic-browser-token",
          };
        },
        { gatewayUrl },
      );
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".chat-workspace-toggle").click();
      const upload = page.getByRole("button", { name: "Upload workspace files" });
      await upload.waitFor();
      expect(await page.evaluate(() => WebSocket.toString())).toContain("[native code]");
      expect(browserHello).toMatchObject({
        auth: { scopes: expect.not.arrayContaining(["operator.admin"]) },
        policy: { maxPayload: MAX_PAYLOAD_BYTES },
        features: {
          capabilities: expect.arrayContaining(["control-ui.server-authorized-methods"]),
        },
      });
      expect(await page.locator(".chat-workspace-rail__path").count()).toBe(0);
      const bytes = Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES, 0xab);
      const expectedHash = createHash("sha256").update(bytes).digest("hex");
      const chooserOpened = page.waitForEvent("filechooser");
      await upload.click();
      const chooser = await chooserOpened;
      await chooser.setFiles({
        name: "limit-16MiB.bin",
        mimeType: "application/octet-stream",
        buffer: bytes,
      });
      await page
        .getByText("Uploaded 1 workspace files", { exact: true })
        .waitFor({ timeout: 60_000 });
      const saved = await readFile(path.join(root, "limit-16MiB.bin"));
      expect(saved.length).toBe(MAX_TERMINAL_UPLOAD_BYTES);
      expect(createHash("sha256").update(saved).digest("hex")).toBe(expectedHash);
      const encodedLength = Math.ceil(MAX_TERMINAL_UPLOAD_BYTES / 3) * 4;
      expect(publicUploadParams).toEqual({
        agentId,
        sessionKey,
        path: "",
        name: "limit-16MiB.bin",
        encodedLength,
      });
      expect(publicFrameBytes).toBeGreaterThan(MAX_TERMINAL_UPLOAD_BYTES);
      expect(publicFrameBytes).toBeLessThan(MAX_PAYLOAD_BYTES);
      const forwarded = privateRequests.filter(
        (request) => request.method === "sessions.files.upload",
      );
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]?.params).toEqual(publicUploadParams);
      expect(forwarded[0]?.frameBytes).toBeLessThan(MAX_PAYLOAD_BYTES);
      await expect.poll(() => publicUploadResult !== undefined).toBe(true);
      expect(publicUploadResult).toMatchObject({
        ok: true,
        payload: { sessionKey, path: "limit-16MiB.bin", size: MAX_TERMINAL_UPLOAD_BYTES },
      });
      expect((publicUploadResult as { payload?: unknown }).payload).not.toHaveProperty("root");
      expect(privateErrors).toEqual([]);
      process.stdout.write(
        `${JSON.stringify({ proof: "workspace-exact-limit-public-private-wire", bytes: saved.length, sha256: expectedHash, publicFrameBytes, privateFrameBytes: forwarded[0]?.frameBytes, maxPayloadBytes: MAX_PAYLOAD_BYTES, browserWebSocketNative: true, bffScopeProjected: true, gatewayHandler: true, syntheticAuthAndSession: true })}\n`,
      );
    } finally {
      await suite.closeBrowserContext(context);
      await ingress.close();
      backend.stop();
      for (const socket of privateServer.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        privateServer.close((error) => (error ? reject(error) : resolve()));
      });
      fixture.loadRoot.mockReset();
      expect(path.dirname(root)).toBe(tempRoot);
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
