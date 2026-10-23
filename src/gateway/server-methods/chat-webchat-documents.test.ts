import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
import { createReplyMediaContext } from "../../auto-reply/reply/reply-media-paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { withAgentMediaContext } from "../../media/agent-media-context.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  buildAssistantDisplayContentFromReplyPayloads,
  hasAssistantDisplayMediaContent,
  hasManagedOutgoingAssistantContent,
  replaceAssistantContentTextBlocks,
  stripManagedOutgoingAssistantContentBlocks,
} from "./chat-assistant-content.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";

describe("webchat generated document ownership", () => {
  let state: OpenClawTestState | undefined;

  afterEach(async () => {
    await state?.cleanup();
    state = undefined;
  });

  it.each([
    { name: "report.pdf", contents: "%PDF-1.7\n", mimeType: "application/pdf" },
    { name: "report.txt", contents: "Generated report\n", mimeType: "text/plain" },
    { name: "report.csv", contents: "name,value\nreport,1\n", mimeType: "text/csv" },
  ])(
    "retains $name ownership through agent normalization before browser projection",
    async (fixture) => {
      state = await createOpenClawTestState({
        layout: "state-only",
        prefix: "openclaw-webchat-agent-document-",
      });
      const agentId = "employee-one";
      const sessionKey = `agent:${agentId}:webchat:direct:user`;
      const sourcePath = path.join(state.workspaceDir, fixture.name);
      await fs.writeFile(sourcePath, fixture.contents);
      const cfg: OpenClawConfig = {
        tools: { allow: ["read"] },
        agents: { list: [{ id: agentId, workspace: state.workspaceDir }] },
      };
      const replyMediaContext = createReplyMediaContext({
        cfg,
        agentId,
        sessionKey,
        workspaceDir: state.workspaceDir,
        ownerScoped: true,
      });
      const buildFinalPayloads = (payloads: Parameters<typeof buildReplyPayloads>[0]["payloads"]) =>
        buildReplyPayloads({
          config: cfg,
          payloads,
          isHeartbeat: false,
          didLogHeartbeatStrip: false,
          blockStreamingEnabled: false,
          blockReplyPipeline: null,
          replyToMode: "off",
          normalizeMediaPaths: replyMediaContext.normalizePayload,
        });
      const { replyPayloads } = await buildFinalPayloads([
        { text: `Generated document\nMEDIA:${sourcePath}` },
      ]);
      const firstPayload = replyPayloads[0];
      if (!firstPayload) {
        throw new Error("expected staged document payload");
      }
      const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
        cfg,
        agentId,
        sessionKey,
        payloads: replyPayloads,
      });
      const transcriptMessage = await buildWebchatAssistantMessageFromReplyPayloads(finalPayloads, {
        localRoots: getAgentScopedMediaLocalRoots(cfg, agentId),
      });
      expect(transcriptMessage?.content).toEqual([
        { type: "text", text: "Generated document" },
        {
          type: "attachment",
          attachment: expect.objectContaining({
            url: replyPayloads[0]?.mediaUrl,
            kind: "document",
            mimeType: fixture.mimeType,
          }),
        },
      ]);
      expect(firstPayload.trustedLocalMedia).toBeUndefined();
      expect(firstPayload.mediaUrl).not.toBe(sourcePath);
      expect(getReplyPayloadMetadata(firstPayload)?.stagedLocalMediaUrls).toEqual([
        firstPayload.mediaUrl,
      ]);

      const replacement = copyReplyPayloadMetadata(firstPayload, {
        text: "Remote replacement",
        mediaUrl: "https://example.com/replacement.pdf",
        mediaUrls: ["https://example.com/replacement.pdf"],
      });
      const replaced = await buildFinalPayloads([replacement]);
      expect(
        getReplyPayloadMetadata(replaced.replyPayloads[0]!)?.stagedLocalMediaUrls,
      ).toBeUndefined();
      const dropped = await buildFinalPayloads([
        copyReplyPayloadMetadata(firstPayload, {
          text: "Missing replacement",
          mediaUrl: path.join(state.workspaceDir, "missing.pdf"),
          mediaUrls: [path.join(state.workspaceDir, "missing.pdf")],
        }),
      ]);
      expect(dropped.replyPayloads[0]?.mediaUrl).toBeUndefined();
      expect(
        getReplyPayloadMetadata(dropped.replyPayloads[0]!)?.stagedLocalMediaUrls,
      ).toBeUndefined();
    },
  );

  it.each(["workspace", "inline"] as const)(
    "keeps both the %s image and its staged document downloadable",
    async (imageSource) => {
      state = await createOpenClawTestState({
        layout: "state-only",
        prefix: "mixed-webchat-media-",
      });
      const agentId = "mixed-owner";
      const sessionKey = `agent:${agentId}:main`;
      const cfg: OpenClawConfig = {
        agents: { entries: { [agentId]: { workspace: state.workspaceDir } } },
      };
      const image = createSolidPngBuffer(2, 2, { r: 20, g: 40, b: 60 });
      const imagePath = path.join(state.workspaceDir, "chart.png");
      const documentPath = path.join(state.workspaceDir, "report.csv");
      await fs.writeFile(imagePath, image);
      await fs.writeFile(documentPath, "name,value\nreport,1\n");
      const context = createReplyMediaContext({
        cfg,
        agentId,
        sessionKey,
        workspaceDir: state.workspaceDir,
        ownerScoped: true,
      });
      const documentPayload = await context.normalizePayload({
        text: "Generated files",
        mediaUrls: imageSource === "workspace" ? [imagePath, documentPath] : [documentPath],
      });
      const input =
        imageSource === "inline"
          ? copyReplyPayloadMetadata(documentPayload, {
              ...documentPayload,
              mediaUrls: [
                `data:image/png;base64,${image.toString("base64")}`,
                documentPayload.mediaUrl!,
              ],
            })
          : documentPayload;
      const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
        cfg,
        agentId,
        sessionKey,
        payloads: [input],
      });
      const blocks = await withAgentMediaContext(agentId, () =>
        buildAssistantDisplayContentFromReplyPayloads({
          sessionKey,
          agentId,
          payloads,
          managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, agentId),
        }),
      );
      expect(blocks?.filter((block) => block.type === "image")).toHaveLength(1);
      expect(blocks?.filter((block) => block.type === "attachment")).toEqual([
        expect.objectContaining({
          attachment: expect.objectContaining({
            kind: "document",
            mimeType: "text/csv",
            artifactId: expect.stringMatching(/^artifact_managed_media_/),
          }),
        }),
      ]);
      expect(blocks?.some((block) => block.attachmentError === true)).toBe(false);
      expect(payloads[0]?.trustedLocalMedia).toBeUndefined();
    },
  );

  it("keeps a visible failure when a preserved image accompanies a missing document", async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "partial-webchat-media-",
    });
    const agentId = "mixed-owner";
    const cfg: OpenClawConfig = {
      agents: { entries: { [agentId]: { workspace: state.workspaceDir } } },
    };
    const image = `data:image/png;base64,${createSolidPngBuffer(2, 2, { r: 20, g: 40, b: 60 }).toString("base64")}`;
    const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg,
      agentId,
      sessionKey: `agent:${agentId}:main`,
      payloads: [
        {
          text: "Generated files",
          mediaUrls: [image, path.join(state.workspaceDir, "missing.pdf")],
        },
      ],
    });
    expect(payload?.mediaUrls).toEqual([image]);
    expect(payload?.text).toContain("⚠️ Media failed.");
    expect(getReplyPayloadMetadata(payload!)?.stagedLocalMediaUrls).toBeUndefined();
  });

  it.each([
    {
      name: "report.pdf",
      contents: "%PDF-1.7\n",
      mimeType: "application/pdf",
      staged: true,
    },
    {
      name: "project.html",
      contents: "<!doctype html><h1>Hello</h1>",
      mimeType: "text/html",
      staged: false,
    },
  ])("stages an ordinary untrusted $name into a persisted owned attachment", async (fixture) => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-webchat-document-flow-",
    });
    const agentId = "employee-one";
    const sourcePath = path.join(state.workspaceDir, fixture.name);
    await fs.writeFile(sourcePath, fixture.contents);
    expect(sourcePath.startsWith(`${resolvePreferredOpenClawTmpDir()}${path.sep}`)).toBe(false);
    const cfg: OpenClawConfig = {
      tools: { allow: ["read"] },
      agents: { list: [{ id: agentId, workspace: state.workspaceDir }] },
    };

    const [normalizedPayload] = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg,
      agentId,
      sessionKey: `agent:${agentId}:webchat:direct:user`,
      payloads: [{ text: "Generated document", mediaUrl: sourcePath }],
    });
    if (fixture.staged) {
      expect(getReplyPayloadMetadata(normalizedPayload!)?.stagedLocalMediaUrls).toContain(
        normalizedPayload?.mediaUrl,
      );
    } else {
      expect(normalizedPayload?.trustedLocalMedia).toBe(true);
    }
    if (fixture.staged) {
      expect(normalizedPayload?.mediaUrl).not.toBe(sourcePath);
      expect(normalizedPayload?.mediaUrl).toContain(
        `${path.sep}media${path.sep}agents${path.sep}${agentId}${path.sep}outbound${path.sep}`,
      );
    } else {
      expect(normalizedPayload?.mediaUrl).toBe(await fs.realpath(sourcePath));
    }
    if (!normalizedPayload) {
      throw new Error("expected normalized document payload");
    }

    const transcriptMessage = await buildWebchatAssistantMessageFromReplyPayloads(
      [normalizedPayload],
      { localRoots: getAgentScopedMediaLocalRoots(cfg, agentId) },
    );
    const persistedContent = replaceAssistantContentTextBlocks(
      await buildAssistantDisplayContentFromReplyPayloads({
        sessionKey: `agent:${agentId}:webchat:direct:user`,
        agentId,
        payloads: [normalizedPayload],
        managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, agentId),
      }),
      transcriptMessage,
    );

    expect(persistedContent).toEqual([
      { type: "text", text: "Generated document" },
      {
        type: "attachment",
        attachment: expect.objectContaining({
          url: expect.stringMatching(/^\/api\/chat\/media\/outgoing\//),
          artifactId: expect.stringMatching(/^artifact_managed_media_/),
          kind: "document",
          mimeType: fixture.mimeType,
        }),
      },
    ]);
    expect(JSON.stringify(persistedContent)).not.toContain(sourcePath);
    expect(JSON.stringify(persistedContent)).not.toContain(normalizedPayload.mediaUrl);
    expect(hasManagedOutgoingAssistantContent(persistedContent)).toBe(true);
    expect(stripManagedOutgoingAssistantContentBlocks(persistedContent)).toEqual([
      { type: "text", text: "Generated document" },
    ]);
  });

  it("reports a durable attachment save failure instead of silently dropping the document", async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-webchat-document-publish-failure-",
    });
    const sourcePath = path.join(state.workspaceDir, "report.txt");
    await fs.writeFile(sourcePath, "prepared report");
    // A directory at the SQLite file path fails the actual record-store publication.
    await fs.mkdir(resolveOpenClawStateSqlitePath(), { recursive: true });
    const errors: string[] = [];
    const content = await withAgentMediaContext(
      "employee-one",
      async () =>
        await buildAssistantDisplayContentFromReplyPayloads({
          sessionKey: "agent:employee-one:main",
          agentId: "employee-one",
          payloads: [{ text: "Prepared report", mediaUrl: sourcePath, trustedLocalMedia: true }],
          managedMediaLocalRoots: [path.dirname(sourcePath)],
          onManagedMediaPrepareError: (message) => {
            errors.push(message);
          },
        }),
    );
    expect(content).toEqual([
      { type: "text", text: "Prepared report" },
      {
        type: "text",
        attachmentError: true,
        text: "[Attachment unavailable] This file could not be saved for download. Attach it again.",
      },
    ]);
    expect(hasAssistantDisplayMediaContent(content)).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain(state.stateDir);
    const originals = state.statePath("media", "agents", "employee-one", "outgoing", "originals");
    expect(await fs.readdir(originals)).toEqual([]);
  });

  it("never grants trust to outside, sensitive, mixed, or pre-existing staged media", async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-webchat-document-denied-",
    });
    const agentId = "employee-one";
    const ownedPath = path.join(state.workspaceDir, "owned.html");
    const ownedDocument = path.join(state.workspaceDir, "owned.pdf");
    const outsidePath = state.path("outside.html");
    const hardlinkedPath = path.join(state.workspaceDir, "hardlinked.html");
    const outboundRoot = state.statePath("media", "outbound");
    await fs.mkdir(outboundRoot, { recursive: true });
    const existingDocument = path.join(outboundRoot, "other-agent.pdf");
    await Promise.all([
      fs.writeFile(ownedPath, "<h1>owned</h1>"),
      fs.writeFile(ownedDocument, "%PDF-1.7\n"),
      fs.writeFile(outsidePath, "<h1>outside</h1>"),
      fs.writeFile(existingDocument, "%PDF-1.7\n"),
    ]);
    await fs.link(outsidePath, hardlinkedPath);
    const cfg: OpenClawConfig = {
      tools: { allow: ["read"] },
      agents: { list: [{ id: agentId, workspace: state.workspaceDir }] },
    };
    const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg,
      agentId,
      sessionKey: `agent:${agentId}:webchat:direct:user`,
      payloads: [
        { mediaUrl: outsidePath },
        { mediaUrl: hardlinkedPath },
        { mediaUrl: ownedPath, sensitiveMedia: true },
        { mediaUrls: [ownedPath, "https://example.com/remote.html"] },
        { mediaUrl: `${outboundRoot}${path.sep}.${path.sep}other-agent.pdf` },
        {
          mediaUrl: `${outboundRoot}${path.sep}..${path.sep}outbound${path.sep}other-agent.pdf`,
        },
        { mediaUrl: existingDocument },
        { mediaUrl: ownedDocument, sensitiveMedia: true },
        { mediaUrls: [ownedDocument, "https://example.com/remote.pdf"] },
      ],
    });

    expect(payloads.every((payload) => payload.trustedLocalMedia !== true)).toBe(true);
    expect(payloads[2]?.sensitiveMedia).toBe(true);
  });
});
