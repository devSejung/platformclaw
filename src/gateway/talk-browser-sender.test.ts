import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
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

afterEach(() => {
  dispatchInboundMessageMock.mockReset();
  testState.sessionStorePath = undefined;
  clearConfigCache();
});

it.each([
  { question: "Check the current task", internalRestriction: false },
  { question: "/config show", internalRestriction: false },
  { question: "Check the current task", internalRestriction: true },
  { question: "/config show", internalRestriction: true },
])(
  "keeps a browser Talk question out of shared operator authority ($question/internal=$internalRestriction)",
  async ({ question, internalRestriction }) => {
    // Install the Gateway test helpers' dispatcher mocks before loading the real handler.
    const { startTalkRealtimeAgentConsult } = await import("./talk-agent-consult.js");
    testState.sessionStorePath = path.join(tempDirs.make("talk-browser-sender-"), "sessions.json");
    await writeSessionStore({
      entries: { main: { sessionId: "talk-browser-session", updatedAt: Date.now() } },
    });
    const context = createDirectChatContext({
      getRuntimeConfig,
      readChatMetadata: vi
        .fn<GatewayRequestContext["readChatMetadata"]>()
        .mockResolvedValue({ models: [], swarmEnabled: false }),
    });
    const client: GatewayClient = {
      connId: "shared-browser-proxy",
      ...(internalRestriction
        ? {
            internal: {
              syntheticClient: true as const,
              senderAttribution: { id: "internal.user", isOwner: false as const },
            },
          }
        : {}),
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
    dispatchInboundMessageMock.mockResolvedValue(undefined);
    const params = {
      context,
      client,
      isWebchatConnect: () => false,
      requestId: "browser-talk-request",
      sessionKey: "agent:main:main",
      callId: "browser-talk-call",
      args: { question },
      senderAttribution: {
        id: "first.user",
        name: "First User",
        agentId: "main",
        ...(!internalRestriction ? { isOwner: false as const } : {}),
      },
    };

    const result = await startTalkRealtimeAgentConsult(params);
    expect(result).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      if (result.ok) {
        const terminal = context.dedupe.get(`chat:${result.runId}`);
        if (terminal?.ok === false) {
          throw new Error(
            `Talk chat failed after ACK: ${JSON.stringify({
              terminal,
              warnings: vi.mocked(context.logGateway.warn).mock.calls,
              errors: vi.mocked(context.logGateway.error).mock.calls,
            })}`,
          );
        }
      }
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    });
    const dispatched = expectDefined(
      dispatchInboundMessageMock.mock.calls[0]?.[0],
      "chat dispatch",
    );
    if (!isRecord(dispatched) || !isRecord(dispatched.ctx)) {
      throw new Error("Expected the real chat dispatcher to receive a message context");
    }
    expect(dispatched.ctx).toMatchObject({
      Body: question,
      SenderId: "first.user",
      SenderIsOwner: false,
      CommandAuthorized: false,
    });
    expect(dispatched.ctx.GatewayClientScopes).not.toContain("operator.admin");
    expect(
      resolveCommandAuthorization({
        ctx: dispatched.ctx,
        cfg: context.getRuntimeConfig(),
        commandAuthorized: dispatched.ctx.CommandAuthorized === true,
      }).senderIsOwner,
    ).toBe(false);
    expect(client.connect.scopes).toEqual(["operator.admin"]);
    await vi.waitFor(() => expect(context.chatAbortControllers.size).toBe(0));
  },
);
