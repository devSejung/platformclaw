import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { replaceAssistantContentTextBlocks } from "./chat-assistant-content.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";

describe("webchat generated document ownership", () => {
  let state: OpenClawTestState | undefined;

  afterEach(async () => {
    await state?.cleanup();
    state = undefined;
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
    expect(normalizedPayload?.trustedLocalMedia).toBe(true);
    if (fixture.staged) {
      expect(normalizedPayload?.mediaUrl).not.toBe(sourcePath);
      expect(normalizedPayload?.mediaUrl).toContain(
        `${path.sep}media${path.sep}outbound${path.sep}`,
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
      [{ type: "text", text: "Generated document" }],
      transcriptMessage,
    );

    expect(persistedContent).toEqual([
      { type: "text", text: "Generated document" },
      {
        type: "attachment",
        attachment: expect.objectContaining({
          url: normalizedPayload.mediaUrl,
          kind: "document",
          mimeType: fixture.mimeType,
        }),
      },
    ]);
    if (fixture.staged) {
      expect(JSON.stringify(persistedContent)).not.toContain(sourcePath);
    }
  });

  it("never grants trust to outside, sensitive, mixed, or pre-existing staged media", async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-webchat-document-denied-",
    });
    const agentId = "employee-one";
    const ownedPath = path.join(state.workspaceDir, "owned.html");
    const outsidePath = state.path("outside.html");
    const hardlinkedPath = path.join(state.workspaceDir, "hardlinked.html");
    const outboundRoot = state.statePath("media", "outbound");
    await fs.mkdir(outboundRoot, { recursive: true });
    const existingDocument = path.join(outboundRoot, "other-agent.pdf");
    await Promise.all([
      fs.writeFile(ownedPath, "<h1>owned</h1>"),
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
      ],
    });

    expect(payloads.every((payload) => payload.trustedLocalMedia !== true)).toBe(true);
    expect(payloads[2]?.sensitiveMedia).toBe(true);
  });
});
