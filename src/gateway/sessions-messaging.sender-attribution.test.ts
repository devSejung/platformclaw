import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ChatSenderAttribution } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, getRuntimeConfig } from "../config/config.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/shared-types.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:main";
const sessionId = "attributed-session";
type SendMethod = "sessions.send" | "sessions.steer";

afterEach(() => {
  dispatchInboundMessageMock.mockReset();
  testState.sessionStorePath = undefined;
  clearConfigCache();
});

async function setup(existingSession = true) {
  testState.sessionStorePath = path.join(tempDirs.make("session-sender-"), "sessions.json");
  await writeSessionStore({
    entries: existingSession ? { main: { sessionId, updatedAt: Date.now() } } : {},
  });
  const context = createDirectChatContext({
    getRuntimeConfig,
    readChatMetadata: vi
      .fn<GatewayRequestContext["readChatMetadata"]>()
      .mockResolvedValue({ models: [], swarmEnabled: false }),
  });
  const client: GatewayClient = {
    connId: "shared-browser-proxy",
    internal: {
      syntheticClient: true,
      senderAttribution: { id: "internal.user", isOwner: false },
    },
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: GATEWAY_CLIENT_IDS.CLI,
        version: "test",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
      role: "operator",
      scopes: ["operator.admin"],
    },
  };
  // Load after Gateway test hooks register their external dispatcher boundary.
  const { sessionMessagingHandlers } = await import("./server-methods/sessions-messaging.js");
  const invoke = async (
    method: SendMethod,
    runId: string,
    senderAttribution: ChatSenderAttribution,
  ) => {
    const handler = expectDefined(sessionMessagingHandlers[method], "session messaging handler");
    const params = { key: sessionKey, message: "hello", idempotencyKey: runId, senderAttribution };
    const respond = vi.fn();
    await handler({
      req: { type: "req", id: runId, method, params },
      params,
      respond,
      context,
      client,
      isWebchatConnect: () => false,
    });
    return respond;
  };
  dispatchInboundMessageMock.mockResolvedValue(undefined);
  return { context, invoke };
}

async function expectDispatched(context: GatewayRequestContext, runId: string) {
  await vi.waitFor(() => {
    const terminal = context.dedupe.get(`chat:${runId}`);
    if (terminal?.ok === false) {
      throw new Error(
        `Chat failed after ACK: ${JSON.stringify({
          terminal,
          warnings: vi.mocked(context.logGateway.warn).mock.calls,
          errors: vi.mocked(context.logGateway.error).mock.calls,
        })}`,
      );
    }
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
  });
  const dispatched = dispatchInboundMessageMock.mock.calls[0]?.[0];
  if (!isRecord(dispatched) || !isRecord(dispatched.ctx)) {
    throw new Error("Expected the actual chat handler to reach the model dispatcher");
  }
  await vi.waitFor(() => expect(context.chatAbortControllers.size).toBe(0));
  return dispatched.ctx;
}

it.each(
  (["sessions.send", "sessions.steer"] as const).flatMap((method) => [
    { method, agentId: " main ", expectedAgentId: "main" },
    { method, agentId: " ", expectedAgentId: undefined },
  ]),
)(
  "$method normalizes optional sender Agent ID '$agentId' before actual chat admission",
  async ({ method, agentId, expectedAgentId }) => {
    const { context, invoke } = await setup();
    const runId = `${method}-normalized-sender`;
    const respond = await invoke(method, runId, { id: " first.user ", agentId });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId, status: "started" }),
      undefined,
      expect.objectContaining({ runId }),
    );
    const ctx = await expectDispatched(context, runId);
    expect(ctx).toMatchObject({ SenderId: "first.user", SenderIsOwner: false });
    expect(ctx.SenderAgentId).toBe(expectedAgentId);
    expect(ctx.GatewayClientScopes).not.toContain("operator.admin");
  },
);

it.each(["sessions.send", "sessions.steer"] as const)(
  "%s rejects blank sender ID before lifecycle work and permits a corrected same-key retry",
  async (method) => {
    const { context, invoke } = await setup(method === "sessions.steer");
    const previous = new AbortController();
    if (method === "sessions.steer") {
      context.chatAbortControllers.set("previous-run", {
        controller: previous,
        sessionId,
        sessionKey,
        startedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        projectSessionActive: true,
      });
    }
    const runId = `${method}-correctable-sender`;
    const denied = await invoke(method, runId, { id: " ", agentId: "main" });
    expect(denied).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "sender attribution id must not be blank",
      }),
    );
    expect(context.dedupe.size).toBe(0);
    expect(previous.signal.aborted).toBe(false);
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    const { loadSessionEntryReadOnly } = await import("./session-utils.js");
    const entry = loadSessionEntryReadOnly(sessionKey).entry;
    expect(entry?.sessionId).toBe(method === "sessions.steer" ? sessionId : undefined);
    const accepted = await invoke(method, runId, {
      id: "first.user",
      agentId: "main",
      isOwner: false,
    });
    expect(accepted).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId, status: "started" }),
      undefined,
      expect.objectContaining({ runId }),
    );
    await expectDispatched(context, runId);
    if (method === "sessions.steer") {
      expect(previous.signal.aborted).toBe(true);
    } else {
      expect(loadSessionEntryReadOnly(sessionKey).entry?.sessionId).toEqual(expect.any(String));
    }
  },
);
