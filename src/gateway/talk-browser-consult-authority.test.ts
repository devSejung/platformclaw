import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntimeCore } from "../plugins/runtime/types-core.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
} from "../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../talk/provider-types.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createTalkClientConsultRunner } from "./talk-client-consult.js";
import { TalkClientSessionOwner } from "./talk-client-session-owner.js";
import { drainingRelaySessions } from "./talk-realtime-relay-state.js";
import {
  createTalkRealtimeRelaySession,
  stopTalkRealtimeRelaySession,
} from "./talk-realtime-relay.js";

const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn<PluginRuntimeCore["agent"]["runEmbeddedAgent"]>(async () => ({
    payloads: [{ text: "Completed." }],
    meta: { durationMs: 1 },
  })),
}));

vi.mock("../plugins/runtime/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/runtime/index.js")>();
  return {
    ...actual,
    createPluginRuntime: (...args: Parameters<typeof actual.createPluginRuntime>) => {
      const runtime = actual.createPluginRuntime(...args);
      return { ...runtime, agent: { ...runtime.agent, runEmbeddedAgent: mocks.runEmbeddedAgent } };
    },
  };
});

const snapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const relayIds: string[] = [];
let tempDir: string;
let config: OpenClawConfig;
const sessionKey = "agent:main:main";
const senderAttribution = { id: "first.user", agentId: "main", isOwner: false as const };

beforeEach(async () => {
  tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "talk-consult-authority-")));
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  config = {
    agents: { entries: { main: { default: true, workspace: path.join(tempDir, "workspace") } } },
  };
  await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey });
  mocks.runEmbeddedAgent.mockClear();
});

afterEach(async () => {
  for (const relaySessionId of relayIds.splice(0)) {
    stopTalkRealtimeRelaySession({ relaySessionId, connId: "proxy-consult" });
  }
  await Promise.all(
    [...drainingRelaySessions].map(async (session) => {
      if (session.voiceSessionClose) {
        await session.voiceSessionClose;
      }
    }),
  );
  expect(drainingRelaySessions.size).toBe(0);
  clientVoiceSessionTesting.reset();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  snapshot.restore();
  await fs.rm(tempDir, { recursive: true, force: true });
});

it.each(["native", "relay"])(
  "carries the browser's restricted authority through the real %s consult runtime",
  async (transport) => {
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    let runConsult: NonNullable<RealtimeVoiceBridgeCreateRequest["runAgentConsult"]>;
    if (transport === "native") {
      const voiceSessionId = createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
      });
      runConsult = createTalkClientConsultRunner({
        config,
        context,
        agentId: "main",
        sessionKey,
        connId: "proxy-consult",
        initialItems: [],
        owner: new TalkClientSessionOwner(),
        getVoiceSessionId: () => voiceSessionId,
        senderAttribution,
      });
    } else {
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const provider: RealtimeVoiceProviderPlugin = {
        id: "test-voice",
        label: "Test Voice",
        isConfigured: () => true,
        createBridge: (request) => {
          bridgeRequest = request;
          return {
            connect: async () => undefined,
            close: () => undefined,
            isConnected: () => true,
            sendAudio: () => undefined,
            setMediaTimestamp: () => undefined,
            handleBargeIn: () => undefined,
            submitToolResult: () => undefined,
            acknowledgeMark: () => undefined,
          };
        },
      };
      const relay = createTalkRealtimeRelaySession({
        context,
        connId: "proxy-consult",
        cfg: config,
        provider,
        providerConfig: {},
        instructions: "Answer the user's request.",
        tools: [],
        sessionKey,
        senderAttribution,
      });
      relayIds.push(relay.relaySessionId);
      runConsult = expectDefined(bridgeRequest?.runAgentConsult, "provider consult callback");
    }
    await expect(runConsult({ prompt: "Check the current task" })).resolves.toEqual({
      text: "Completed.",
    });
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        senderId: "first.user",
        senderAgentId: "main",
        senderIsOwner: false,
        agentId: "main",
        sessionKey,
      }),
    );
  },
);
