import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setupBrowserGatewayProxyTest as setupHarness,
  NOW,
} from "./browser-gateway-proxy.test-harness.js";
import {
  PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH,
  PLATFORMCLAW_TALK_OFFER_PREFIX,
} from "./browser-gateway-talk-policy.js";

const connection = { connectionId: "browser-1" };

async function setup() {
  const result = await setupHarness();
  const access = await result.proxy.resolveAccess(result.token, false);
  result.proxy.registerBrowserConnection(connection.connectionId, access);
  result.proxy.registerBrowserConnection("browser-2", access);
  return result;
}

function transcription(id = "dictation-1") {
  return {
    sessionId: id,
    transcriptionSessionId: id,
    provider: "test-stt",
    mode: "transcription",
    transport: "gateway-relay",
    brain: "none",
    expiresAt: Math.floor((NOW + 60_000) / 1000),
    audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
  };
}

function clientVoice(id = "voice-1") {
  return {
    provider: "test-voice",
    transport: "webrtc",
    voiceSessionId: id,
    clientSecret: "test-ephemeral-token",
    expiresAt: NOW + 60_000,
    offerUrl: "https://voice.example.test/calls",
    privateConfig: { apiKey: "test-private-key" },
  };
}

describe("browser Talk ownership", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pins non-owner sender authority for voice creation and every browser consult", async () => {
    const { proxy, token, request, binding } = await setup();
    const access = await proxy.resolveAccess(token, false);
    const sender = {
      id: "first.user",
      name: "First User",
      profileId: access.user.id,
      agentId: binding.agentId,
      isOwner: false,
    };
    request.mockResolvedValueOnce(clientVoice());
    await proxy.request(token, "talk.client.create", {}, connection);
    expect(request).toHaveBeenLastCalledWith("talk.client.create", {
      sessionKey: `agent:${binding.agentId}:main`,
      senderAttribution: sender,
    });
    request.mockResolvedValueOnce({ runId: "browser-consult", idempotencyKey: "browser-consult" });
    await proxy.request(
      token,
      "talk.client.toolCall",
      {
        sessionKey: `agent:${binding.agentId}:main`,
        voiceSessionId: "voice-1",
        callId: "browser-call",
        name: "openclaw_agent_consult",
        args: { question: "/config show" },
      },
      connection,
    );
    expect(request).toHaveBeenLastCalledWith(
      "talk.client.toolCall",
      expect.objectContaining({ senderAttribution: sender }),
    );
    await expect(
      proxy.request(token, "talk.client.create", { senderAttribution: sender }, connection),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await proxy.releaseBrowserConnection(connection.connectionId);
  });

  it("pins dictation to its authenticated browser and isolates audio events", async () => {
    const { proxy, token, request, binding, auditEvents, user } = await setup();
    request.mockResolvedValueOnce(transcription());
    const result = await proxy.request(
      token,
      "talk.session.create",
      {
        mode: "transcription",
        transport: "gateway-relay",
        brain: "none",
      },
      connection,
    );
    expect(result).toEqual(transcription());
    expect(request).toHaveBeenCalledWith("talk.session.create", {
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
      sessionKey: `agent:${binding.agentId}:main`,
      clientOwnerId: connection.connectionId,
      senderAttribution: {
        id: "first.user",
        name: "First User",
        profileId: user.id,
        agentId: binding.agentId,
        isOwner: false,
      },
    });
    const event = {
      event: "talk.event",
      payload: {
        transcriptionSessionId: "dictation-1",
        type: "transcript",
        text: "hello",
        final: true,
        privateConfig: "private",
      },
    };
    expect(await proxy.filterEvent(token, event, connection)).toEqual({
      event: "talk.event",
      payload: {
        transcriptionSessionId: "dictation-1",
        type: "transcript",
        text: "hello",
        final: true,
      },
    });
    expect(await proxy.filterEvent(token, event, { connectionId: "browser-2" })).toBeNull();
    await expect(
      proxy.request(
        token,
        "talk.session.appendAudio",
        { sessionId: "dictation-1", audioBase64: "aGVsbG8=" },
        { connectionId: "browser-2" },
      ),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    request.mockResolvedValueOnce({ ok: true });
    await expect(
      proxy.request(
        token,
        "talk.session.appendAudio",
        { sessionId: "dictation-1", audioBase64: "aGVsbG8=" },
        connection,
      ),
    ).resolves.toEqual({ ok: true });
    await proxy.releaseBrowserConnection(connection.connectionId);
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "talk.session.close" && isRecord(params) && params.sessionId === "dictation-1",
      ),
    ).toHaveLength(1);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        eventType: "browser.talk.closed",
        details: expect.objectContaining({ outcome: "closed" }),
      }),
    );
  });

  it("keeps client voice sessions and consult wait IDs inside their browser lease", async () => {
    const { proxy, token, request, binding } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request.mockResolvedValueOnce(clientVoice());
    await expect(
      proxy.request(token, "talk.client.create", { sessionKey: key }, connection),
    ).resolves.toEqual(expect.not.objectContaining({ privateConfig: expect.anything() }));
    await expect(
      proxy.request(
        token,
        "talk.client.transcript",
        {
          sessionKey: key,
          voiceSessionId: "unknown",
          entryId: "entry-1",
          role: "user",
          text: "hello",
        },
        connection,
      ),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    await expect(
      proxy.request(
        token,
        "talk.client.transcript",
        {
          sessionKey: "agent:other:main",
          voiceSessionId: "voice-1",
          entryId: "entry-1",
          role: "user",
          text: "hello",
        },
        connection,
      ),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    request.mockResolvedValueOnce({
      runId: "consult-1",
      idempotencyKey: "consult-1",
      privatePath: "/private",
    });
    await expect(
      proxy.request(
        token,
        "talk.client.toolCall",
        {
          sessionKey: key,
          voiceSessionId: "voice-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "hello" },
        },
        connection,
      ),
    ).resolves.toEqual({ runId: "consult-1", idempotencyKey: "consult-1" });
    await expect(
      proxy.request(token, "agent.wait", { runId: "foreign-run" }, connection),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    await expect(
      proxy.request(token, "agent.wait", { runId: "consult-1" }, { connectionId: "browser-2" }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    request.mockResolvedValueOnce({ status: "ok", endedAt: NOW, privatePath: "/private" });
    await expect(
      proxy.request(token, "agent.wait", { runId: "consult-1", timeoutMs: 100 }, connection),
    ).resolves.toEqual({ status: "ok", endedAt: NOW });
    await proxy.releaseBrowserConnection(connection.connectionId);
  });

  it("projects only catalog capabilities and the fallback transport from config", async () => {
    const { proxy, token, request, binding } = await setup();
    request.mockResolvedValueOnce({
      modes: ["realtime", "transcription"],
      transports: ["webrtc"],
      brains: ["agent-consult"],
      speech: { providers: [] },
      transcription: { ready: true, providers: [] },
      realtime: {
        ready: true,
        providers: [
          { id: "test-voice", label: "Voice", configured: true, apiKey: "test-private-key" },
        ],
      },
      privatePath: "/private",
    });
    const result = await proxy.request(token, "talk.catalog", {});
    expect(result).not.toHaveProperty("privatePath");
    expect(result).toHaveProperty("realtime.providers", [
      { id: "test-voice", label: "Voice", configured: true },
    ]);
    expect(request).toHaveBeenLastCalledWith("talk.catalog", {
      sessionKey: `agent:${binding.agentId}:main`,
    });
    request.mockResolvedValueOnce({
      config: {
        talk: {
          realtime: {
            transport: "gateway-relay",
            providers: { test: { apiKey: "test-private-key" } },
            instructions: "private",
          },
        },
        session: { mainKey: "private" },
      },
    });
    await expect(proxy.request(token, "talk.config", {})).resolves.toEqual({
      config: { talk: { realtime: { transport: "gateway-relay" } } },
    });
    await expect(
      proxy.request(token, "talk.config", { includeSecrets: true }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
  });

  it("does not revive a closed or unregistered browser while resolving authentication", async () => {
    const { proxy, token, request, binding } = await setup();
    const key = `agent:${binding.agentId}:main`;
    await proxy.releaseBrowserConnection(connection.connectionId);
    request.mockClear();
    await expect(
      proxy.request(token, "talk.client.create", { sessionKey: key }, connection),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(
      proxy.request(
        token,
        "talk.client.create",
        { sessionKey: key },
        { connectionId: "unregistered" },
      ),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a native call alive after its one-shot credential expires and preserves runs on resume", async () => {
    vi.useFakeTimers();
    const { proxy, token, request, binding } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request.mockResolvedValueOnce(clientVoice());
    await proxy.request(token, "talk.client.create", { sessionKey: key }, connection);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({ runId: "resume-run", idempotencyKey: "resume-run" });
    await proxy.request(
      token,
      "talk.client.toolCall",
      {
        sessionKey: key,
        voiceSessionId: "voice-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: {},
      },
      connection,
    );
    request.mockResolvedValueOnce(clientVoice());
    await proxy.request(
      token,
      "talk.client.create",
      { sessionKey: key, voiceSessionId: "voice-1" },
      connection,
    );
    request.mockResolvedValueOnce({ status: "ok" });
    await expect(
      proxy.request(token, "agent.wait", { runId: "resume-run" }, connection),
    ).resolves.toEqual({ status: "ok" });
    await proxy.releaseBrowserConnection(connection.connectionId);
  });

  it("releases closed relay quotas and records failed provider cleanup", async () => {
    const { proxy, token, request, auditEvents } = await setup();
    request.mockResolvedValueOnce(transcription("one")).mockResolvedValueOnce(transcription("two"));
    await proxy.request(token, "talk.session.create", { mode: "transcription" }, connection);
    await proxy.request(token, "talk.session.create", { mode: "transcription" }, connection);
    expect(
      await proxy.filterEvent(
        token,
        {
          event: "talk.event",
          payload: { transcriptionSessionId: "one", type: "close", reason: "error" },
        },
        connection,
      ),
    ).toMatchObject({ payload: { type: "close" } });
    request.mockResolvedValueOnce(transcription("three"));
    await proxy.request(token, "talk.session.create", { mode: "transcription" }, connection);
    request.mockRejectedValue(new Error("provider unavailable"));
    await proxy.releaseBrowserConnection(connection.connectionId);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        eventType: "browser.talk.closed",
        details: expect.objectContaining({ outcome: "cleanup_failed" }),
      }),
    );
  });

  it("keeps dictation finals after close ACK while denying writes and foreign event delivery", async () => {
    vi.useFakeTimers();
    const { proxy, token, request, auditEvents } = await setup();
    request.mockResolvedValueOnce(transcription("one")).mockResolvedValueOnce(transcription("two"));
    await proxy.request(token, "talk.session.create", { mode: "transcription" }, connection);
    await proxy.request(token, "talk.session.create", { mode: "transcription" }, connection);
    await expect(
      proxy.request(token, "talk.session.close", { sessionId: "one" }, connection),
    ).resolves.toEqual({ ok: true });
    await expect(
      proxy.request(
        token,
        "talk.session.appendAudio",
        { sessionId: "one", audioBase64: "aGVsbG8=" },
        connection,
      ),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "talk.session.create", { mode: "transcription" }, connection),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    for (const text of ["last utterance", "another final utterance"]) {
      const final = {
        event: "talk.event",
        payload: { transcriptionSessionId: "one", type: "transcript", text, final: true },
      };
      expect(await proxy.filterEvent(token, final, { connectionId: "browser-2" })).toBeNull();
      expect(await proxy.filterEvent(token, final, connection)).toEqual(final);
    }
    const terminal = {
      event: "talk.event",
      payload: { transcriptionSessionId: "one", type: "close", reason: "completed" },
    };
    expect(await proxy.filterEvent(token, terminal, { connectionId: "browser-2" })).toBeNull();
    expect(await proxy.filterEvent(token, terminal, connection)).toEqual(terminal);
    expect(await proxy.filterEvent(token, terminal, connection)).toBeNull();
    request.mockResolvedValueOnce(transcription("three"));
    await proxy.request(token, "talk.session.create", { mode: "transcription" }, connection);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(auditEvents).not.toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({ outcome: "terminal_event_missing" }),
      }),
    );
    await proxy.releaseBrowserConnection(connection.connectionId);
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "talk.session.close" && isRecord(params) && params.sessionId === "one",
      ),
    ).toHaveLength(1);
  });

  it("reclaims a missing dictation terminal event within the UI drain window", async () => {
    vi.useFakeTimers();
    const { proxy, token, request, auditEvents } = await setup();
    request.mockResolvedValueOnce(transcription("one")).mockResolvedValueOnce(transcription("two"));
    await proxy.request(token, "talk.session.create", { mode: "transcription" }, connection);
    await proxy.request(token, "talk.session.create", { mode: "transcription" }, connection);
    await proxy.request(token, "talk.session.close", { sessionId: "one" }, connection);
    await vi.advanceTimersByTimeAsync(9_999);
    await expect(
      proxy.request(token, "talk.session.create", { mode: "transcription" }, connection),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await vi.advanceTimersByTimeAsync(1);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        eventType: "browser.talk.closed",
        details: expect.objectContaining({
          voiceSessionId: "one",
          outcome: "terminal_event_missing",
        }),
      }),
    );
    expect(
      await proxy.filterEvent(
        token,
        {
          event: "talk.event",
          payload: {
            transcriptionSessionId: "one",
            type: "transcript",
            text: "too late",
            final: true,
          },
        },
        connection,
      ),
    ).toBeNull();
    request.mockResolvedValueOnce(transcription("three"));
    await proxy.request(token, "talk.session.create", { mode: "transcription" }, connection);
    await proxy.releaseBrowserConnection(connection.connectionId);
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "talk.session.close" && isRecord(params) && params.sessionId === "one",
      ),
    ).toHaveLength(1);
  });

  it("rejects browser quota identities and cleans up a creation that outlives its connection", async () => {
    const { proxy, token, request, binding } = await setup();
    await expect(
      proxy.request(
        token,
        "talk.session.create",
        { mode: "transcription", clientOwnerId: "forged" },
        connection,
      ),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    let complete: ((value: unknown) => void) | undefined;
    request.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = proxy.request(
      token,
      "talk.client.create",
      { sessionKey: `agent:${binding.agentId}:main` },
      connection,
    );
    await vi.waitFor(() => expect(complete).toBeDefined());
    await proxy.releaseBrowserConnection(connection.connectionId);
    request.mockResolvedValue({ ok: true });
    complete?.(clientVoice());
    await expect(pending).rejects.toMatchObject({ code: "unauthenticated" });
    expect(request).toHaveBeenLastCalledWith("talk.client.close", {
      sessionKey: `agent:${binding.agentId}:main`,
      voiceSessionId: "voice-1",
    });
  });

  it("closes an Agent's voices and prevents pending or later creates from reviving its connections", async () => {
    const { proxy, token, request, binding, auditEvents } = await setup();
    request.mockResolvedValueOnce(clientVoice());
    await proxy.request(token, "talk.client.create", {}, connection);
    let complete: ((value: unknown) => void) | undefined;
    request.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = proxy.request(token, "talk.client.create", {}, { connectionId: "browser-2" });
    await vi.waitFor(() => expect(complete).toBeDefined());
    await proxy.closeTalkForAgent(binding.agentId, "credentials_revoked");
    complete?.(clientVoice("pending-voice"));
    await expect(pending).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(proxy.request(token, "talk.client.create", {}, connection)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    await expect(
      proxy.request(token, "talk.client.create", {}, { connectionId: "browser-2" }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          voiceSessionId: "voice-1",
          reason: "credentials_revoked",
        }),
      }),
    );
    for (const id of ["voice-1", "pending-voice"]) {
      expect(
        request.mock.calls.filter(
          ([method, params]) =>
            method === "talk.client.close" && isRecord(params) && params.voiceSessionId === id,
        ),
      ).toHaveLength(1);
    }
  });

  it("keeps two active sessions per browser without making all users share that quota", async () => {
    const { proxy, token, request } = await setup();
    request.mockResolvedValueOnce(transcription("one")).mockResolvedValueOnce(transcription("two"));
    await proxy.request(token, "talk.session.create", { mode: "transcription" }, connection);
    await proxy.request(token, "talk.session.create", { mode: "transcription" }, connection);
    await expect(
      proxy.request(token, "talk.session.create", { mode: "transcription" }, connection),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    request.mockResolvedValueOnce(transcription("three"));
    await expect(
      proxy.request(
        token,
        "talk.session.create",
        { mode: "transcription" },
        { connectionId: "browser-2" },
      ),
    ).resolves.toHaveProperty("sessionId", "three");
    await proxy.releaseBrowserConnection(connection.connectionId);
    await proxy.releaseBrowserConnection("browser-2");
  });

  it("rewrites only the Gateway's leased offer path and consumes its ticket once", async () => {
    const { proxy, token, request, binding } = await setup();
    request.mockResolvedValueOnce({
      ...clientVoice(),
      offerUrl: PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH,
    });
    const result = await proxy.request<{ offerUrl: string }>(
      token,
      "talk.client.create",
      { sessionKey: `agent:${binding.agentId}:main` },
      connection,
    );
    expect(result.offerUrl).toMatch(new RegExp(`^${PLATFORMCLAW_TALK_OFFER_PREFIX}[a-f0-9-]+$`));
    const access = await proxy.resolveAccess(token, false);
    const ticket = result.offerUrl.slice(PLATFORMCLAW_TALK_OFFER_PREFIX.length);
    expect(() =>
      proxy.claimTalkOffer({ ...access, user: { ...access.user, id: "other-user" } }, ticket),
    ).toThrow("unavailable");
    expect(proxy.claimTalkOffer(access, ticket)).toEqual({
      path: PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH,
      secret: "test-ephemeral-token",
    });
    expect(() => proxy.claimTalkOffer(access, ticket)).toThrow("unavailable");
    await proxy.releaseBrowserConnection(connection.connectionId);
  });

  it("fails visibly and cleans up when a local provider offer has no configured relay", async () => {
    const { proxy, token, request, binding } = await setupHarness({
      talkOfferRelayAvailable: false,
    });
    proxy.registerBrowserConnection(
      connection.connectionId,
      await proxy.resolveAccess(token, false),
    );
    request.mockResolvedValueOnce({
      ...clientVoice(),
      offerUrl: PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH,
    });
    await expect(
      proxy.request(
        token,
        "talk.client.create",
        { sessionKey: `agent:${binding.agentId}:main` },
        connection,
      ),
    ).rejects.toThrow("Local Talk offer relay is unavailable");
    expect(request).toHaveBeenLastCalledWith("talk.client.close", {
      sessionKey: `agent:${binding.agentId}:main`,
      voiceSessionId: "voice-1",
    });
    await proxy.releaseBrowserConnection(connection.connectionId);
  });
});
