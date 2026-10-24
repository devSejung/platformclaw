// Integration coverage for targetless WebChat tool sends through the internal
// source-reply sink and embedded-run payload projection.
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
import { createReplyMediaContext } from "../../auto-reply/reply/reply-media-paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildAssistantDisplayContentFromReplyPayloads } from "../../gateway/server-methods/chat-assistant-content.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "../../gateway/server-methods/chat-reply-media.js";
import { withAgentMediaContext } from "../../media/agent-media-context.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-subscribe.tools.js";
import { createMessageTool } from "./message-tool.js";

describe("WebChat message tool internal source reply", () => {
  it("exports a runtime attachment through the actual message tool and source-reply sink", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-tool-runtime-" },
      async (state) =>
        withAgentMediaContext("main", async () => {
          const source = "/home/synthetic/project/report.txt";
          const bytes = Buffer.from("actual message tool runtime bytes");
          const signal = new AbortController().signal;
          const readFile = vi.fn(async () => bytes);
          const assertCurrentAuthority = vi.fn(async () => undefined);
          const cfg: OpenClawConfig = {
            agents: {
              defaults: { mediaMaxMb: 0.125 },
              list: [{ id: "main", workspace: state.workspaceDir }],
            },
          };
          const sandboxOutboundFileAccess = {
            tempDir: "/tmp/synthetic-private",
            readFile,
            assertCurrentAuthority,
          };
          const tool = createMessageTool({
            config: cfg,
            currentChannelProvider: "webchat",
            sourceReplyDeliveryMode: "automatic",
            agentSessionKey: "agent:main:webchat:dm:dashboard",
            runId: "runtime-message-run",
            sandboxRoot: "/unrelated/gateway/workspace",
            sandboxOutboundFileAccess,
            getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
            resolveCommandSecretRefsViaGateway: async ({ config }) => ({
              resolvedConfig: config,
              diagnostics: [],
              targetStatesByPath: {},
              hadUnresolvedTargets: false,
            }),
          });
          const result = await tool.execute(
            "runtime-file",
            {
              action: "send",
              media: source,
              mediaUrls: [source],
              attachments: [{ path: source }],
            },
            signal,
          );
          const reply = extractMessagingToolSourceReplyPayload(result);
          expect(reply?.mediaUrl).toBeTypeOf("string");
          expect(reply?.mediaUrl).not.toBe(source);
          expect(reply?.mediaUrls).toEqual([reply?.mediaUrl]);
          await expect(fs.readFile(reply!.mediaUrl!)).resolves.toEqual(bytes);
          expect(readFile).toHaveBeenCalledExactlyOnceWith({
            filePath: source,
            maxBytes: 128 * 1024,
            signal,
          });
          const authority = getReplyPayloadMetadata(reply!)?.mediaPublishAuthority;
          expect(getReplyPayloadMetadata(reply!)?.stagedLocalMediaUrls).toEqual([reply!.mediaUrl]);
          expect(authority).toBeTypeOf("function");
          expect(Object.hasOwn(reply!, "mediaPublishAuthority")).toBe(false);
          const embedded = buildEmbeddedRunPayloads({
            assistantTexts: [],
            toolMetas: [],
            lastAssistant: undefined,
            currentAssistant: undefined,
            sessionKey: "agent:main:webchat:dm:dashboard",
            sourceReplyDeliveryMode: "automatic",
            messagingToolSourceReplyPayloads: [reply!],
            runId: "runtime-message-run",
            inlineToolResultsAllowed: false,
            verboseLevel: "off",
            reasoningLevel: "off",
            toolResultFormat: "plain",
          });
          expect(getReplyPayloadMetadata(embedded[0]!)?.mediaPublishAuthority).toBe(authority);
          const { replyPayloads } = await buildReplyPayloads({
            payloads: embedded,
            isHeartbeat: false,
            didLogHeartbeatStrip: false,
            blockStreamingEnabled: false,
            blockReplyPipeline: null,
            replyToMode: "off",
            normalizeMediaPaths: createReplyMediaContext({
              cfg,
              agentId: "main",
              sessionKey: "agent:main:webchat:dm:dashboard",
              workspaceDir: state.workspaceDir,
              ownerScoped: true,
              runtimeSandbox: { outboundFileAccess: sandboxOutboundFileAccess },
            }).normalizePayload,
          });
          expect(getReplyPayloadMetadata(replyPayloads[0]!)?.mediaPublishAuthority).toBe(authority);
          expect(getReplyPayloadMetadata(replyPayloads[0]!)?.stagedLocalMediaUrls).toEqual([
            reply!.mediaUrl,
          ]);
          const [displayPayload] = await normalizeWebchatReplyMediaPathsForDisplay({
            cfg,
            agentId: "main",
            sessionKey: "agent:main:webchat:dm:dashboard",
            payloads: replyPayloads,
          });
          expect(getReplyPayloadMetadata(displayPayload!)?.stagedLocalMediaUrls).toEqual([
            reply!.mediaUrl,
          ]);
          expect(getReplyPayloadMetadata(displayPayload!)?.mediaPublishAuthority).toBe(authority);
          const content = await buildAssistantDisplayContentFromReplyPayloads({
            agentId: "main",
            sessionKey: "agent:main:webchat:dm:dashboard",
            payloads: [displayPayload!],
            managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, "main"),
          });
          expect(content).toContainEqual({
            type: "attachment",
            attachment: expect.objectContaining({
              artifactId: expect.any(String),
              label: expect.stringContaining("report"),
              mimeType: "text/plain",
            }),
          });
          expect(content?.some((block) => block.attachmentError === true)).toBe(false);
          expect(readFile).toHaveBeenCalledTimes(1);
          assertCurrentAuthority.mockRejectedValueOnce(new Error("runtime authority changed"));
          await expect(authority!()).rejects.toThrow("runtime authority changed");
        }),
    );
  });

  it("checks current runtime authority before returning a captured UI source reply", async () => {
    const readFile = vi.fn(async () => Buffer.from("must not read"));
    const tool = createMessageTool({
      config: {},
      currentChannelProvider: "webchat",
      sourceReplyDeliveryMode: "automatic",
      agentSessionKey: "agent:main:webchat:dm:dashboard",
      runId: "runtime-denied-run",
      sandboxOutboundFileAccess: {
        tempDir: "/tmp/synthetic-private",
        readFile,
        assertCurrentAuthority: async () => {
          throw new Error("runtime authority changed");
        },
      },
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config }) => ({
        resolvedConfig: config,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
    });
    await expect(
      tool.execute("runtime-denied", {
        action: "send",
        media: "https://example.test/synthetic-report.pdf",
      }),
    ).rejects.toThrow("runtime authority changed");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("projects a real targetless send and preserves the automatic final reply", async () => {
    const tool = createMessageTool({
      config: { agents: { entries: { main: { default: true } } } },
      currentChannelProvider: "webchat",
      sourceReplyDeliveryMode: "automatic",
      agentSessionKey: "agent:main:webchat:dm:dashboard",
      runId: "webchat-run",
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config }) => ({
        resolvedConfig: config,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
    });

    const toolResult = await tool.execute("message-call", {
      action: "send",
      message: "Visible progress from the message tool.",
    });
    expect(toolResult.details).toMatchObject({
      channel: "webchat",
      target: "current-run",
      sourceReplyDeliveryMode: "message_tool_only",
      sourceReplySink: "internal-ui",
      sourceReply: { text: "Visible progress from the message tool." },
    });

    const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
    expect(sourceReply).toMatchObject({ text: "Visible progress from the message tool." });

    const embeddedPayloads = buildEmbeddedRunPayloads({
      assistantTexts: ["Visible automatic final reply."],
      toolMetas: [],
      lastAssistant: undefined,
      currentAssistant: undefined,
      sessionKey: "agent:main:webchat:dm:dashboard",
      sourceReplyDeliveryMode: "automatic",
      messagingToolSourceReplyPayloads: sourceReply ? [sourceReply] : [],
      runId: "webchat-run",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });
    const { replyPayloads: payloads } = await buildReplyPayloads({
      payloads: embeddedPayloads,
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
      messagingToolSentTexts: ["Visible progress from the message tool."],
    });

    expect(payloads.map((payload) => payload.text)).toEqual([
      "Visible progress from the message tool.",
      "Visible automatic final reply.",
    ]);
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:webchat:dm:dashboard",
        text: "Visible progress from the message tool.",
        idempotencyKey: "webchat-run:internal-source-reply:0",
      },
    });
    expect(getReplyPayloadMetadata(payloads[1] as object)?.sourceReplyTranscriptMirror).toBe(
      undefined,
    );
  });
});
