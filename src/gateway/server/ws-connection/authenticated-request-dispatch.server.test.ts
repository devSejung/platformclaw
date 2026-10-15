import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type {
  RequestFrame,
  ResponseFrame,
} from "../../../../packages/gateway-protocol/src/index.js";
import { upsertSessionEntry } from "../../../config/sessions/session-accessor.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { MAX_PAYLOAD_BYTES } from "../../server-constants.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import * as sessionSharing from "../../session-sharing.js";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  startGatewayServer,
  trackConnectChallengeNonce,
} from "../../test-helpers.js";
import {
  resetTestPluginRegistry,
  setTestPluginRegistry,
} from "../../test-helpers.plugin-registry.js";
import type { GatewayWsClient } from "../ws-types.js";
import { createGatewayAuthenticatedRequestDispatcher } from "./authenticated-request-dispatch.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

const TRACEPARENTS = {
  first: "00-11111111111111111111111111111111-1111111111111111-01",
  second: "00-22222222222222222222222222222222-2222222222222222-00",
} as const;

installGatewayTestHooks({ scope: "suite" });

function createClient(): GatewayWsClient {
  return {
    socket: {} as WebSocket,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin"],
    },
    connId: "conn-trace-test",
    usesSharedGatewayAuth: false,
  };
}

function createDispatcher(
  handler: NonNullable<GatewayWsMessageHandlerParams["extraHandlers"][string]>,
  method = "test.trace",
  context = {} as GatewayRequestContext,
) {
  const send = vi.fn();
  const close = vi.fn();
  const setCloseCause = vi.fn();
  const buildRequestContext = vi.fn(() => context);
  const logGateway = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const dispatcher = createGatewayAuthenticatedRequestDispatcher({
    handler: {
      connId: "conn-trace-test",
      extraHandlers: { [method]: handler },
      buildRequestContext,
      send,
      close,
      isClosed: () => false,
      setCloseCause,
      logGateway,
    } as unknown as GatewayWsMessageHandlerParams,
    isWebchatConnect: () => false,
  });
  return { dispatcher, logGateway, send, close, setCloseCause, buildRequestContext };
}

function maximumInboundDownloadRequest(params?: unknown): RequestFrame {
  const request: RequestFrame = {
    type: "req",
    id: "",
    method: "sessions.files.download",
    ...(params === undefined ? {} : { params }),
  };
  request.id = "i".repeat(MAX_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify(request), "utf8"));
  return request;
}

async function dispatchInFreshMessageScope(
  dispatcher: ReturnType<typeof createDispatcher>["dispatcher"],
  client: GatewayWsClient,
  id: string,
  traceparent?: string,
): Promise<void> {
  await runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () =>
    dispatcher.dispatch(
      {
        type: "req",
        id,
        method: "test.trace",
        params: {},
        ...(traceparent ? { traceparent } : {}),
      },
      client,
    ),
  );
}

async function openAuthenticatedTraceSocket(params: {
  port: number;
  token: string;
  connectTraceparent: string;
  scopes?: string[];
}): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${params.port}`, { maxPayload: MAX_PAYLOAD_BYTES });
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      ws.off("open", onOpen);
      reject(error);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
  try {
    await connectOk(ws, {
      token: params.token,
      traceparent: params.connectTraceparent,
      scopes: params.scopes,
    });
    return ws;
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

async function sendTraceRequest(
  ws: WebSocket,
  id: string,
  traceparent?: string,
): Promise<{ ok: boolean }> {
  const response = onceMessage<{ type: "res"; id: string; ok: boolean }>(
    ws,
    (value) => value.type === "res" && value.id === id,
  );
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "test.trace",
      params: {},
      ...(traceparent ? { traceparent } : {}),
    }),
  );
  return await response;
}

describe("authenticated WebSocket request trace dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["draft", "incognito", "scope"] as const)(
    "bounds an inbound-limit download ID before %s authorization or target lookup",
    async (denial) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const sessionKey = "agent:main:download-dispatch-denied";
        await upsertSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId: "download-dispatch-denied",
            updatedAt: 1,
            createdActor: { type: "human", id: "owner" },
            visibility: denial === "draft" ? "draft" : "shared",
            ...(denial === "incognito" ? { incognito: true } : {}),
          },
        );
        const authorization = vi.spyOn(sessionSharing, "resolveSessionMutationAuthorization");
        const getRuntimeConfig = vi.fn(() => ({}));
        const handler = vi.fn();
        const { dispatcher, send, close, buildRequestContext } = createDispatcher(
          handler,
          "sessions.files.download",
          { getRuntimeConfig, logGateway: { warn: vi.fn() } } as unknown as GatewayRequestContext,
        );
        const client = createClient();
        client.connect.scopes = denial === "scope" ? [] : ["operator.read"];
        client.authenticatedUserId = "viewer";
        client.authenticatedUserProfile = {
          profileId: "viewer",
          displayName: "viewer",
          hasAvatar: false,
          updatedAt: 1,
        };
        const requestParams = { sessionKey, path: "a" };
        await dispatcher.dispatch(
          { type: "req", id: "ordinary", method: "sessions.files.download", params: requestParams },
          client,
        );
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        const ordinary = send.mock.calls[0]?.[0] as ResponseFrame;
        expect(ordinary.ok).toBe(false);
        if (denial === "draft") {
          expect(ordinary.error?.details).toMatchObject({ code: "SESSION_READ_DENIED" });
        } else if (denial === "incognito") {
          expect(ordinary.error?.message).toBe(`Incognito session "${sessionKey}" was not found.`);
        } else {
          expect(ordinary.error).toMatchObject({
            code: "FORBIDDEN",
            details: { missingScope: "operator.read" },
          });
        }
        expect(handler).not.toHaveBeenCalled();
        vi.clearAllMocks();

        const request = maximumInboundDownloadRequest(requestParams);
        expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBe(MAX_PAYLOAD_BYTES);
        await dispatcher.dispatch(request, client);
        expect(send).toHaveBeenCalledOnce();
        const compact = send.mock.calls[0]?.[0] as ResponseFrame;
        expect(compact.error).toEqual({ code: "INVALID_REQUEST", message: "Shorten request" });
        expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThanOrEqual(
          MAX_PAYLOAD_BYTES,
        );
        expect(authorization).not.toHaveBeenCalled();
        expect(buildRequestContext).not.toHaveBeenCalled();
        expect(getRuntimeConfig).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      });
    },
  );

  it.each([undefined, {}, { sessionKey: "a", path: 1 }])(
    "closes without an oversized echoed error for inbound-limit ID and invalid params %j",
    async (requestParams) => {
      const handler = vi.fn();
      const { dispatcher, send, close, setCloseCause, buildRequestContext } =
        createDispatcher(handler);
      const request = maximumInboundDownloadRequest(requestParams);
      expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBe(MAX_PAYLOAD_BYTES);
      await dispatcher.dispatch(request, createClient());
      expect(send).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledExactlyOnceWith(1009, "download response too large");
      expect(setCloseCause).toHaveBeenCalledExactlyOnceWith("download-envelope-too-large", {
        method: "sessions.files.download",
      });
      expect(buildRequestContext).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(["invalidated", "shared-auth-stale"] as const)(
    "preserves %s credential-close precedence over envelope errors",
    async (failure) => {
      const client = createClient();
      client.invalidated = failure === "invalidated";
      client.usesSharedGatewayAuth = failure === "shared-auth-stale";
      client.sharedGatewaySessionGeneration = 1;
      const send = vi.fn();
      const close = vi.fn();
      const buildRequestContext = vi.fn();
      const dispatcher = createGatewayAuthenticatedRequestDispatcher({
        handler: {
          connId: "download-stale-client",
          extraHandlers: {},
          getRequiredSharedGatewaySessionGeneration: () => 2,
          send,
          close,
          buildRequestContext,
          isClosed: () => false,
          setCloseCause: vi.fn(),
        } as unknown as GatewayWsMessageHandlerParams,
        isWebchatConnect: () => false,
      });
      await dispatcher.dispatch(maximumInboundDownloadRequest(), client);
      expect(send).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledExactlyOnceWith(
        4001,
        failure === "invalidated" ? "client invalidated: invalidated" : "gateway auth changed",
      );
      expect(buildRequestContext).not.toHaveBeenCalled();
    },
  );

  it("continues a valid upstream trace as a child context", async () => {
    let observed: DiagnosticTraceContext | undefined;
    const { dispatcher } = createDispatcher(() => {
      observed = getActiveDiagnosticTraceContext();
    });

    await dispatchInFreshMessageScope(dispatcher, createClient(), "first", TRACEPARENTS.first);
    await vi.waitFor(() => {
      expect(observed).toBeDefined();
    });

    expect(observed).toMatchObject({
      traceId: "11111111111111111111111111111111",
      parentSpanId: "1111111111111111",
      traceFlags: "01",
    });
    expect(observed?.spanId).not.toBe("1111111111111111");
  });

  it("keeps handler failure logging and responses inside the request trace", async () => {
    let loggedContext: DiagnosticTraceContext | undefined;
    let responseContext: DiagnosticTraceContext | undefined;
    const { dispatcher, logGateway, send } = createDispatcher(async () => {
      throw new Error("expected trace failure");
    });
    logGateway.error.mockImplementation(() => {
      loggedContext = getActiveDiagnosticTraceContext();
    });
    send.mockImplementation(() => {
      responseContext = getActiveDiagnosticTraceContext();
    });

    await dispatchInFreshMessageScope(dispatcher, createClient(), "failure", TRACEPARENTS.first);
    await vi.waitFor(() => {
      expect(logGateway.error).toHaveBeenCalled();
      expect(send).toHaveBeenCalled();
    });

    expect(loggedContext).toMatchObject({
      traceId: "11111111111111111111111111111111",
      parentSpanId: "1111111111111111",
      traceFlags: "01",
    });
    expect(responseContext).toEqual(loggedContext);
  });

  it.each([false, true])(
    "waits for opted-in send completion without duplicate error responses (failed=%s)",
    async (failed) => {
      let finished = false;
      let complete: ((error?: Error) => void) | undefined;
      const { dispatcher, send, logGateway } = createDispatcher(async ({ respond }) => {
        await respond.withCompletion!(true, { synthetic: true });
        finished = true;
      });
      send.mockImplementation((_frame: unknown, onComplete?: (error?: Error) => void) => {
        complete = onComplete;
      });
      await dispatchInFreshMessageScope(dispatcher, createClient(), "completion");
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(finished).toBe(false);
      expect(complete).toBeTypeOf("function");
      complete?.(failed ? new Error("synthetic terminal failure") : undefined);
      await vi.waitFor(() => expect(finished).toBe(true));
      expect(send).toHaveBeenCalledOnce();
      expect(logGateway.error).not.toHaveBeenCalled();
    },
  );

  it("retains fresh roots for missing and malformed traceparent values", async () => {
    const observed = new Map<string, DiagnosticTraceContext | undefined>();
    const { dispatcher } = createDispatcher(({ req }) => {
      observed.set(req.id, getActiveDiagnosticTraceContext());
    });
    const client = createClient();

    await dispatchInFreshMessageScope(dispatcher, client, "missing");
    await vi.waitFor(() => {
      expect(observed.has("missing")).toBe(true);
    });
    await dispatchInFreshMessageScope(
      dispatcher,
      client,
      "malformed",
      "00-11111111111111111111111111111111-1111111111111111-zz",
    );
    await vi.waitFor(() => {
      expect(observed.has("malformed")).toBe(true);
    });

    const missing = observed.get("missing");
    const malformed = observed.get("malformed");
    expect(missing).toBeDefined();
    expect(malformed).toBeDefined();
    expect(missing?.traceId).not.toBe("11111111111111111111111111111111");
    expect(malformed?.traceId).not.toBe("11111111111111111111111111111111");
    expect(missing?.traceId).not.toBe(malformed?.traceId);
  });

  it("isolates concurrent request contexts on one connection", async () => {
    let releaseRequests: (() => void) | undefined;
    const requestBarrier = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const observed = new Map<
      string,
      { before: DiagnosticTraceContext | undefined; after?: DiagnosticTraceContext }
    >();
    const { dispatcher } = createDispatcher(async ({ req }) => {
      const observation: {
        before: DiagnosticTraceContext | undefined;
        after?: DiagnosticTraceContext;
      } = { before: getActiveDiagnosticTraceContext() };
      observed.set(req.id, observation);
      await requestBarrier;
      observation.after = getActiveDiagnosticTraceContext();
    });
    const client = createClient();

    await Promise.all([
      dispatchInFreshMessageScope(dispatcher, client, "first", TRACEPARENTS.first),
      dispatchInFreshMessageScope(dispatcher, client, "second", TRACEPARENTS.second),
    ]);
    await vi.waitFor(() => {
      expect(observed.size).toBe(2);
    });
    releaseRequests?.();
    await vi.waitFor(() => {
      expect([...observed.values()].every((entry) => entry.after)).toBe(true);
    });

    expect(observed.get("first")?.before?.traceId).toBe("11111111111111111111111111111111");
    expect(observed.get("second")?.before?.traceId).toBe("22222222222222222222222222222222");
    expect(observed.get("first")?.after).toEqual(observed.get("first")?.before);
    expect(observed.get("second")?.after).toEqual(observed.get("second")?.before);
  });

  it("preserves request isolation and bounded download errors through real authenticated WebSockets", async () => {
    const observed = new Map<
      string,
      { before: DiagnosticTraceContext | undefined; after?: DiagnosticTraceContext }
    >();
    let requestBarrier: Promise<void> | undefined;
    let releaseRequests: (() => void) | undefined;
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["test.trace"] = async ({ req, respond }) => {
      const observation: {
        before: DiagnosticTraceContext | undefined;
        after?: DiagnosticTraceContext;
      } = { before: getActiveDiagnosticTraceContext() };
      observed.set(req.id, observation);
      await requestBarrier;
      observation.after = getActiveDiagnosticTraceContext();
      respond(true, { traced: true });
    };
    setTestPluginRegistry(registry);

    const token = "gateway-request-trace-test-token";
    const port = await getFreePort();
    const server = await startGatewayServer(port, {
      auth: { mode: "token", token },
      bind: "loopback",
      controlUiEnabled: false,
    });
    let ws: WebSocket | undefined;
    let limitedWs: WebSocket | undefined;
    try {
      ws = await openAuthenticatedTraceSocket({
        port,
        token,
        connectTraceparent: TRACEPARENTS.first,
      });

      await expect(sendTraceRequest(ws, "untraced-after-connect")).resolves.toMatchObject({
        ok: true,
      });
      await expect(
        sendTraceRequest(
          ws,
          "malformed",
          "00-11111111111111111111111111111111-1111111111111111-zz",
        ),
      ).resolves.toMatchObject({ ok: true });
      const afterConnect = observed.get("untraced-after-connect")?.before;
      const malformed = observed.get("malformed")?.before;
      expect(afterConnect).toBeDefined();
      expect(malformed).toBeDefined();
      expect(afterConnect?.traceId).not.toBe("11111111111111111111111111111111");
      expect(malformed?.traceId).not.toBe("11111111111111111111111111111111");
      expect(malformed?.traceId).not.toBe(afterConnect?.traceId);

      requestBarrier = new Promise<void>((resolve) => {
        releaseRequests = resolve;
      });
      const first = sendTraceRequest(ws, "concurrent-first", TRACEPARENTS.first);
      const second = sendTraceRequest(ws, "concurrent-second", TRACEPARENTS.second);
      await vi.waitFor(() => {
        expect(observed.has("concurrent-first")).toBe(true);
        expect(observed.has("concurrent-second")).toBe(true);
      });
      releaseRequests?.();
      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { ok: true },
        { ok: true },
      ]);

      const firstObservation = observed.get("concurrent-first");
      const secondObservation = observed.get("concurrent-second");
      expect(firstObservation?.before).toMatchObject({
        traceId: "11111111111111111111111111111111",
        parentSpanId: "1111111111111111",
        traceFlags: "01",
      });
      expect(secondObservation?.before).toMatchObject({
        traceId: "22222222222222222222222222222222",
        parentSpanId: "2222222222222222",
        traceFlags: "00",
      });
      expect(firstObservation?.after).toEqual(firstObservation?.before);
      expect(secondObservation?.after).toEqual(secondObservation?.before);

      // Reuse this isolated server: the receive cap would close on the old oversized scope error.
      limitedWs = await openAuthenticatedTraceSocket({
        port,
        token,
        connectTraceparent: TRACEPARENTS.first,
        scopes: [],
      });
      const request = maximumInboundDownloadRequest({ sessionKey: "a", path: "a" });
      const boundedResponse = onceMessage<ResponseFrame>(
        limitedWs,
        (frame) => frame.type === "res" && frame.id === request.id,
      );
      limitedWs.send(JSON.stringify(request));
      const compact = await boundedResponse;
      expect(compact.error).toEqual({ code: "INVALID_REQUEST", message: "Shorten request" });
      expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThanOrEqual(
        MAX_PAYLOAD_BYTES,
      );
      expect(limitedWs.readyState).toBe(WebSocket.OPEN);

      const scopeResponse = onceMessage<ResponseFrame>(
        limitedWs,
        (frame) => frame.type === "res" && frame.id === "ordinary-download-scope",
      );
      limitedWs.send(JSON.stringify({ ...request, id: "ordinary-download-scope" }));
      expect((await scopeResponse).error).toMatchObject({
        code: "FORBIDDEN",
        details: { missingScope: "operator.read" },
      });
      expect(limitedWs.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws?.terminate();
      limitedWs?.terminate();
      await server.close();
      resetTestPluginRegistry();
    }
  });
});
