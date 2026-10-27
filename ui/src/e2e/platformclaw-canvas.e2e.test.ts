// PlatformClaw Canvas E2E crosses client capability gating, show_widget, Gateway hosting, and BFF relay.
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { PlatformClawBrowserCanvasRelay } from "../../../packages/platformclaw-control-plane/src/browser-canvas-http.js";
import { PlatformClawBrowserMediaRelay } from "../../../packages/platformclaw-control-plane/src/browser-media-http.js";
import { filterToolsByPolicy } from "../../../src/agents/agent-tools.policy.js";
import { createOpenClawTools } from "../../../src/agents/openclaw-tools.js";
import { createSandboxFsBridge } from "../../../src/agents/sandbox/fs-bridge.js";
import { createSandboxFsBridgeFromResolver } from "../../../src/agents/test-helpers/host-sandbox-fs-bridge.js";
import { expandToolGroups } from "../../../src/agents/tool-policy-shared.js";
import { resolveCanvasNodeCapability } from "../../../src/canvas/constants.js";
import { replaceSessionEntry } from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "../../../src/gateway/auth.js";
import {
  attachManagedOutgoingMediaToMessage,
  resolveManagedOutgoingMediaArtifactDownload,
} from "../../../src/gateway/managed-image-attachments.js";
import { createGatewayHttpServer } from "../../../src/gateway/server-http.js";
import { buildAssistantDisplayContentFromReplyPayloads } from "../../../src/gateway/server-methods/chat-assistant-content.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "../../../src/gateway/server-methods/chat-reply-media.js";
import { appendAssistantTranscriptMessage } from "../../../src/gateway/server-methods/chat-transcript-persistence.js";
import type { GatewayWsClient } from "../../../src/gateway/server/ws-types.js";
import { withAgentMediaContext } from "../../../src/media/agent-media-context.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  canvasPromptProbeMarkup,
  exerciseCanvasPromptDelivery,
} from "./platformclaw-canvas.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const proofDir = path.resolve(
  process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR ?? ".artifacts/control-ui-e2e/platformclaw-canvas",
);
const agentId = "assigned-personal";
const sessionKey = `agent:${agentId}:main`;
const gatewayToken = "platformclaw-canvas-e2e-token";
const attachmentName = "project-report.pdf";
const attachmentSource =
  "media://inbound/project-report---43007e90-2ade-43f2-a781-42b843e9eca3.pdf";
const generatedDocumentName = "project-page.html";
const inlineImageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
const resolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: gatewayToken,
  allowTailscale: false,
};

let browser: Browser;
let controlUi: ControlUiE2eServer;

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected TCP server address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describeControlUiE2e("PlatformClaw browser Canvas delivery", () => {
  beforeAll(async () => {
    await mkdir(proofDir, { recursive: true });
    controlUi = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await controlUi?.close();
  });

  it.each([
    { label: "Basic", target: "platform_server", locale: "en-US" },
    { label: "Assigned VM", target: "assigned_vm", locale: "ko-KR" },
  ] as const)(
    "renders show_widget through the BFF on $label",
    async ({ label, target, locale }) => {
      const state = await createOpenClawTestState({ prefix: "platformclaw-canvas-e2e-" });
      const stateDir = state.stateDir;
      onTestFinished(() => state.cleanup());
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const generatedWorkspace = path.join(stateDir, "workspace");
        const generatedDocumentSource = path.join(generatedWorkspace, generatedDocumentName);
        await mkdir(generatedWorkspace, { recursive: true });
        const basicBridge = createSandboxFsBridge({
          sandbox: {
            workspaceDir: generatedWorkspace,
            agentWorkspaceDir: generatedWorkspace,
            workspaceAccess: "rw",
            containerName: "canvas-e2e-unused",
            containerWorkdir: "/workspace",
            docker: {},
          },
        });
        // Local mapping covers the assigned-VM bridge contract. A separate
        // real SSH fixture proves remote execution without an operator VM.
        const assignedVmBridge = createSandboxFsBridgeFromResolver((filePath, cwd) => {
          const remoteCwd = cwd?.startsWith("/workspace") ? cwd : "/workspace";
          const containerPath = path.posix.resolve(remoteCwd, filePath);
          if (containerPath !== "/workspace" && !containerPath.startsWith("/workspace/")) {
            throw new Error("escapes assigned VM workspace");
          }
          const relativePath = path.posix.relative("/workspace", containerPath);
          return {
            hostPath: path.join(generatedWorkspace, ...relativePath.split("/").filter(Boolean)),
            relativePath,
            containerPath,
          };
        });
        const config: OpenClawConfig = {
          agents: { entries: { [agentId]: { default: true, workspace: generatedWorkspace } } },
          plugins: {
            entries: { canvas: { enabled: false, config: { host: { enabled: true } } } },
          },
          tools: { deny: ["group:nodes"] },
        };
        await state.writeConfig(config);
        const tools = filterToolsByPolicy(
          createOpenClawTools({
            agentSessionKey: sessionKey,
            clientCaps: ["inline-widgets"],
            config,
            disableMessageTool: true,
            disablePluginTools: true,
            sandboxed: true,
            sessionId: `${target}-session`,
            wrapBeforeToolCallHook: false,
            workspaceDir: generatedWorkspace,
            sandboxRoot: target === "assigned_vm" ? "/workspace" : generatedWorkspace,
            sandboxFsBridge: target === "assigned_vm" ? assignedVmBridge : basicBridge,
          }),
          { deny: expandToolGroups(config.tools?.deny) },
        );
        expect(tools.map((tool) => tool.name)).toContain("show_widget");
        for (const unavailable of ["canvas", "nodes", "computer", "mobile_ui"]) {
          expect(
            tools.map((tool) => tool.name),
            unavailable,
          ).not.toContain(unavailable);
        }
        const showWidget = tools.find((tool) => tool.name === "show_widget");
        if (!showWidget?.execute) {
          throw new Error("expected show_widget tool");
        }
        await expect(
          showWidget.execute(`reject-file-url-${target}`, {
            title: `${label} local file`,
            url: "file:///users/assigned.personal/.platformclaw/workspace/widget.html",
          }),
        ).rejects.toThrow("widget_code required");
        const widgetCode = [
          `<main data-proof-target="${target}"><h1>${label}</h1><p>Gateway-owned widget</p>`,
          canvasPromptProbeMarkup(),
          '<img data-proof-relative-image src="pixel.png" alt="Workspace image">',
          `<img data-proof-image src="data:image/png;base64,${inlineImageBase64}" alt="Inline image">`,
          '<img data-proof-blob-image alt="Blob image">',
          `<script>document.querySelector("[data-proof-blob-image]").src=URL.createObjectURL(new Blob([Uint8Array.from(atob("${inlineImageBase64}"),character=>character.charCodeAt(0))],{type:"image/png"}))</script>`,
          "</main>",
        ].join("");
        await writeFile(generatedDocumentSource, widgetCode);
        await writeFile(
          path.join(generatedWorkspace, "pixel.png"),
          Buffer.from(inlineImageBase64, "base64"),
        );
        await expect(
          showWidget.execute(`reject-remote-image-${target}`, {
            title: `${label} remote image`,
            widget_code: '<img src="https://blocked-widget-image.invalid/pixel.png">',
          }),
        ).rejects.toThrow("cannot fetch image URL");
        const toolResult = await showWidget.execute(`show-widget-${target}`, {
          title: `${label} widget`,
          widget_code: await readFile(generatedDocumentSource, "utf8"),
          widget_path: `/workspace/${generatedDocumentName}`,
        });
        const details = toolResult.details as {
          view?: { url?: string };
        };
        const documentPath = details.view?.url;
        if (!documentPath) {
          throw new Error("show_widget did not return a document URL");
        }
        const normalized = await normalizeWebchatReplyMediaPathsForDisplay({
          cfg: config,
          agentId,
          sessionKey,
          payloads: [
            {
              text: "Generated HTML document",
              mediaUrl: generatedDocumentSource,
              trustedLocalMedia: true,
            },
          ],
        });
        const persistedAssistantContent = await withAgentMediaContext(agentId, () =>
          buildAssistantDisplayContentFromReplyPayloads({
            agentId,
            sessionKey,
            payloads: normalized,
            managedMediaLocalRoots: [generatedWorkspace],
          }),
        );
        const attachmentBlock = persistedAssistantContent?.find(
          (block) => block.type === "attachment",
        );
        const attachment = attachmentBlock?.attachment as { artifactId?: string } | undefined;
        if (!persistedAssistantContent || !attachment?.artifactId) {
          throw new Error("generated HTML did not produce a managed artifact");
        }
        const sessionId = `${target}-session`;
        const storePath = path.join(state.sessionsDir(agentId), "sessions.json");
        await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 1 });
        const appended = await appendAssistantTranscriptMessage({
          agentId,
          sessionKey,
          sessionId,
          storePath,
          cfg: config,
          createIfMissing: true,
          message: "Generated HTML document",
          content: persistedAssistantContent,
        });
        if (!appended.ok || !appended.messageId) {
          throw new Error("generated HTML transcript was not persisted");
        }
        await attachManagedOutgoingMediaToMessage({
          messageId: appended.messageId,
          blocks: persistedAssistantContent,
        });
        const managedDownload = await resolveManagedOutgoingMediaArtifactDownload({
          agentId,
          sessionKey,
          artifactId: attachment.artifactId,
        });
        if (!managedDownload) {
          throw new Error("generated HTML artifact has no authenticated download");
        }
        await unlink(generatedDocumentSource);

        const gateway = createGatewayHttpServer({
          clients: new Set<GatewayWsClient>(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          handlePluginRequest: async () => false,
          resolvePluginNodeCapabilityRoute: (pathContext) =>
            resolveCanvasNodeCapability(pathContext.candidates),
          resolvedAuth,
          getRuntimeConfig: () => config,
        });
        const gatewayOrigin = await listen(gateway);
        const historyMessages = [
          {
            role: "user",
            content: "Uploaded document",
            __openclaw: {
              id: "uploaded-document-message",
              media: [
                {
                  path: "/srv/private/media/inbound/project-report---43007e90-2ade-43f2-a781-42b843e9eca3.pdf",
                  url: attachmentSource,
                  fileName: attachmentName,
                  contentType: "application/pdf",
                },
              ],
            },
            timestamp: 1,
          },
          {
            role: "assistant",
            content: persistedAssistantContent,
            __openclaw: { id: "generated-document-message" },
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: `show-widget-${target}`,
            toolName: "show_widget",
            content: toolResult.content,
            details: toolResult.details,
            timestamp: 3,
          },
        ];
        const mediaRequests: URL[] = [];
        const mediaRelay = new PlatformClawBrowserMediaRelay({
          gatewayOrigin,
          gatewayAuth: gatewayToken,
          gatewayProxy: {
            resolveAccess: async () => ({ binding: { agentId } }),
            request: async <T = unknown>(_token: string, method: string, params?: unknown) => {
              if (method === "chat.message.get") {
                const messageId = (params as { messageId?: string } | undefined)?.messageId;
                const message = historyMessages.find(
                  (entry) => entry["__openclaw"]?.id === messageId,
                );
                return { ok: Boolean(message), message } as T;
              }
              return { sessionKey, messages: historyMessages } as T;
            },
          },
          resolveAgentIdFromSessionKey: (value) => /^agent:([^:]+):/u.exec(value)?.[1] ?? null,
          fetchImpl: async (input, init) => {
            const url = new URL(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            );
            mediaRequests.push(url);
            if (url.pathname.startsWith("/api/chat/media/outgoing/")) {
              return fetch(input, init);
            }
            const source = url.searchParams.get("source");
            expect(source).toBe(attachmentSource);
            expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${gatewayToken}`);
            expect(new Headers(init?.headers).get("x-openclaw-agent-id")).toBe(agentId);
            return url.searchParams.get("meta") === "1"
              ? Response.json({
                  available: true,
                  mimeType: "application/pdf",
                  mediaTicket: "upstream-ticket-must-not-escape",
                })
              : new Response("%PDF-1.4\nowned attachment", {
                  headers: {
                    "Content-Disposition": `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(attachmentName)}`,
                    "Content-Type": "application/pdf",
                  },
                });
          },
        });
        let canvasNow = 1_000;
        const bff = createServer((req, res) => {
          void relay.handle(req, res).then(async (handled) => {
            if (!handled && !(await mediaRelay.handle(req, res))) {
              res.statusCode = 404;
              res.end();
            }
          });
        });
        const bffOrigin = await listen(bff);
        const relay = new PlatformClawBrowserCanvasRelay({
          publicOrigin: bffOrigin,
          gatewayOrigin,
          gatewayAuth: gatewayToken,
          gatewayProxy: {
            resolveAccess: async () => ({ binding: { agentId } }),
          },
          now: () => canvasNow,
        });
        const surface = relay.issueSurface({ binding: { agentId } });
        canvasNow = surface.expiresAtMs + 1;
        const refreshedSurface = relay.issueSurface({ binding: { agentId } });
        const context = await browser.newContext({
          locale,
          acceptDownloads: true,
          viewport: { width: 1280, height: 900 },
          ...(process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? {
                recordVideo: {
                  dir: path.join(proofDir, target),
                  size: { width: 1280, height: 900 },
                },
              }
            : {}),
        });
        try {
          await context.addCookies([
            { name: "platformclaw_session", value: "browser-token", url: bffOrigin },
          ]);
          const page = await context.newPage();
          const browserMediaRequests: URL[] = [];
          await context.route("**/__openclaw__/assistant-media?**", async (route) => {
            const requestUrl = new URL(route.request().url());
            browserMediaRequests.push(requestUrl);
            const response = await route.fetch({
              url: `${bffOrigin}${requestUrl.pathname}${requestUrl.search}`,
            });
            await route.fulfill({ response });
          });
          const gatewayMock = await installMockGateway(page, {
            assistantAgentId: agentId,
            defaultAgentId: agentId,
            deferredMethods: ["plugin.surface.refresh"],
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "chat.send",
              "sessions.describe",
              "sessions.list",
              "plugin.surface.refresh",
            ],
            historyMessages,
            methodResponses: {
              "plugin.surface.refresh": refreshedSurface,
              "artifacts.download": {
                artifact: {
                  id: attachment.artifactId,
                  type: "file",
                  title: managedDownload.title,
                  mimeType: managedDownload.mimeType,
                  download: { mode: "url" },
                },
                url: `${bffOrigin}${managedDownload.url}`,
                expiresAt: managedDownload.expiresAt,
              },
            },
            pluginSurfaceUrls: surface.pluginSurfaceUrls,
            sessionKey,
            // Retry reconciles against the idle-run metadata real history includes.
            sessionInfo: { key: sessionKey, hasActiveRun: false, activeRunIds: [], status: "done" },
          });
          await page.goto(`${controlUi.baseUrl}chat`);
          await expect
            .poll(async () => (await gatewayMock.getRequests("connect")).length)
            .toBeGreaterThan(0);
          const connectParams = (await gatewayMock.getRequests("connect"))[0]?.params as {
            caps?: string[];
          };
          expect(connectParams.caps).toContain("inline-widgets");

          const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
          await preview.waitFor();
          const staleFrame = await preview.locator("iframe").elementHandle();
          expect(await preview.locator("iframe").getAttribute("src")).toBe(
            `${surface.pluginSurfaceUrls.canvas}${documentPath}`,
          );
          await expect
            .poll(async () => (await gatewayMock.getRequests("plugin.surface.refresh")).length)
            .toBe(1);
          await gatewayMock.resolveDeferred("plugin.surface.refresh", refreshedSurface);
          await expect
            .poll(async () => {
              const current = await preview.locator("iframe").elementHandle();
              return current && staleFrame
                ? !(await current.evaluate((node, old) => node === old, staleFrame))
                : false;
            })
            .toBe(true);
          expect(await preview.locator("iframe").getAttribute("src")).toBe(
            `${refreshedSurface.pluginSurfaceUrls.canvas}${documentPath}`,
          );
          const frame = preview.frameLocator("iframe");
          await expect
            .poll(() => frame.locator(`[data-proof-target="${target}"]`).textContent())
            .toContain(label);
          await expect
            .poll(() =>
              frame
                .locator("[data-proof-relative-image]")
                .evaluate((element) =>
                  element instanceof HTMLImageElement && element.complete
                    ? element.naturalWidth
                    : 0,
                ),
            )
            .toBe(1);
          await expect
            .poll(() =>
              frame
                .locator("[data-proof-image]")
                .evaluate((element) =>
                  element instanceof HTMLImageElement && element.complete
                    ? element.naturalWidth
                    : 0,
                ),
            )
            .toBe(1);
          await expect
            .poll(() =>
              frame
                .locator("[data-proof-blob-image]")
                .evaluate((element) =>
                  element instanceof HTMLImageElement && element.complete
                    ? element.naturalWidth
                    : 0,
                ),
            )
            .toBe(1);
          await page.reload();
          await expect
            .poll(async () => (await gatewayMock.getRequests("plugin.surface.refresh")).length)
            .toBe(1);
          await gatewayMock.resolveDeferred("plugin.surface.refresh", refreshedSurface);
          const reloadedFrame = page
            .locator('.chat-tool-card__preview[data-kind="canvas"]')
            .frameLocator("iframe");
          for (const selector of [
            "[data-proof-relative-image]",
            "[data-proof-image]",
            "[data-proof-blob-image]",
          ]) {
            await expect
              .poll(() =>
                reloadedFrame
                  .locator(selector)
                  .evaluate((element) =>
                    element instanceof HTMLImageElement && element.complete
                      ? element.naturalWidth
                      : 0,
                  ),
              )
              .toBe(1);
          }
          expect(
            await page
              .locator('.chat-tool-card__preview[data-kind="canvas"] iframe')
              .getAttribute("src"),
          ).toBe(`${refreshedSurface.pluginSurfaceUrls.canvas}${documentPath}`);

          const uploadedDocument = page.getByRole("link", { name: attachmentName, exact: true });
          const assistantDocument = page.getByRole("link", {
            name: generatedDocumentName,
            exact: true,
          });
          await uploadedDocument.waitFor({ state: "visible" });
          await assistantDocument.waitFor({ state: "visible" });
          const metadataRequests = browserMediaRequests.filter(
            (request) => request.searchParams.get("meta") === "1",
          );
          expect(metadataRequests.map((request) => request.searchParams.get("source"))).toEqual(
            expect.arrayContaining([attachmentSource]),
          );
          for (const request of metadataRequests) {
            expect(request.searchParams.get("sessionKey")).toBe(sessionKey);
          }
          for (const { document, fileName } of [
            { document: uploadedDocument, fileName: attachmentName },
            { document: assistantDocument, fileName: generatedDocumentName },
          ]) {
            const [download] = await Promise.all([page.waitForEvent("download"), document.click()]);
            expect(download.suggestedFilename()).toBe(fileName);
            const saved = await download.path();
            if (!saved) {
              throw new Error("document download did not complete");
            }
            expect(await readFile(saved, "utf8")).toBe(
              fileName === generatedDocumentName ? widgetCode : "%PDF-1.4\nowned attachment",
            );
          }
          const downloads = browserMediaRequests.filter(
            (request) => request.searchParams.get("meta") !== "1",
          );
          expect(downloads).toHaveLength(1);
          expect(downloads.map((download) => download.searchParams.get("source"))).toEqual([
            attachmentSource,
          ]);
          for (const download of downloads) {
            expect(download.searchParams.get("sessionKey")).toBe(sessionKey);
            expect(download.searchParams.get("mediaTicket")).toMatch(/^v1\./u);
            expect(download.searchParams.get("mediaTicket")).not.toContain("upstream-ticket");
          }
          expect(mediaRequests.some((request) => request.searchParams.get("meta") === "1")).toBe(
            true,
          );
          expect(
            (await gatewayMock.getRequests("artifacts.download")).map((request) => request.params),
          ).toContainEqual({ sessionKey, artifactId: attachment.artifactId });
          expect(
            mediaRequests.some((request) =>
              request.pathname.startsWith("/api/chat/media/outgoing/"),
            ),
          ).toBe(true);

          const uploadedBytes = Buffer.from("%PDF-1.4\nowned attachment");
          await page.locator(".agent-chat__file-input").setInputFiles({
            name: attachmentName,
            mimeType: "application/pdf",
            buffer: uploadedBytes,
          });
          await page.locator(".chat-attachment-file__name", { hasText: attachmentName }).waitFor();
          await page
            .locator(".agent-chat__composer-combobox textarea")
            .fill("Review this document");
          await page.locator(".chat-send-btn:not(.chat-send-btn--voice)").click();
          await expect
            .poll(async () => (await gatewayMock.getRequests("chat.send")).length)
            .toBe(1);
          const uploadedRequest = (await gatewayMock.getRequests("chat.send"))[0]?.params as {
            sessionKey?: string;
            attachments?: unknown[];
          };
          expect(uploadedRequest.sessionKey).toBe(sessionKey);
          expect(uploadedRequest.attachments).toEqual([
            {
              type: "file",
              fileName: attachmentName,
              mimeType: "application/pdf",
              content: uploadedBytes.toString("base64"),
            },
          ]);
          await exerciseCanvasPromptDelivery({
            page,
            gateway: gatewayMock,
            target,
            sessionKey,
            historyMessages,
            proofDir,
          });
          await page.screenshot({
            path: path.join(proofDir, `${target}.png`),
            fullPage: true,
          });
        } finally {
          await context.close();
          await Promise.all([close(bff), close(gateway)]);
        }
      });
    },
  );
});
