// PlatformClaw Canvas E2E crosses client capability gating, show_widget, Gateway hosting, and BFF relay.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformClawBrowserCanvasRelay } from "../../../packages/platformclaw-control-plane/src/browser-canvas-http.js";
import { PlatformClawBrowserMediaRelay } from "../../../packages/platformclaw-control-plane/src/browser-media-http.js";
import { filterToolsByPolicy } from "../../../src/agents/agent-tools.policy.js";
import { createOpenClawTools } from "../../../src/agents/openclaw-tools.js";
import { expandToolGroups } from "../../../src/agents/tool-policy-shared.js";
import { resolveCanvasNodeCapability } from "../../../src/canvas/constants.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "../../../src/gateway/auth.js";
import { createGatewayHttpServer } from "../../../src/gateway/server-http.js";
import { replaceAssistantContentTextBlocks } from "../../../src/gateway/server-methods/chat-assistant-content.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "../../../src/gateway/server-methods/chat-webchat-media.js";
import type { GatewayWsClient } from "../../../src/gateway/server/ws-types.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const proofDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/platformclaw-canvas");
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
      const stateDir = await mkdtemp(path.join(tmpdir(), "platformclaw-canvas-e2e-"));
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const config: OpenClawConfig = {
          agents: { entries: { [agentId]: { default: true } } },
          plugins: {
            entries: { canvas: { enabled: false, config: { host: { enabled: true } } } },
          },
          tools: { deny: ["group:nodes"] },
        };
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
          `<img data-proof-image src="data:image/png;base64,${inlineImageBase64}" alt="Inline image">`,
          '<img data-proof-blob-image alt="Blob image">',
          '<img data-blocked-external src="https://blocked-widget-image.invalid/pixel.png" alt="Blocked external image">',
          `<script>document.querySelector("[data-proof-blob-image]").src=URL.createObjectURL(new Blob([Uint8Array.from(atob("${inlineImageBase64}"),character=>character.charCodeAt(0))],{type:"image/png"}))</script>`,
          "</main>",
        ].join("");
        const generatedWorkspace = path.join(stateDir, "workspace");
        const generatedDocumentSource = path.join(generatedWorkspace, generatedDocumentName);
        await mkdir(generatedWorkspace, { recursive: true });
        await writeFile(generatedDocumentSource, widgetCode);
        const toolResult = await showWidget.execute(`show-widget-${target}`, {
          title: `${label} widget`,
          widget_code: await readFile(generatedDocumentSource, "utf8"),
        });
        const details = toolResult.details as {
          view?: { url?: string };
        };
        const documentPath = details.view?.url;
        if (!documentPath) {
          throw new Error("show_widget did not return a document URL");
        }
        const generatedAssistantMessage = await buildWebchatAssistantMessageFromReplyPayloads(
          [
            {
              text: "Generated HTML document",
              mediaUrl: generatedDocumentSource,
              trustedLocalMedia: true,
            },
          ],
          { localRoots: [generatedWorkspace] },
        );
        if (!generatedAssistantMessage) {
          throw new Error("trusted generated HTML did not produce assistant attachment content");
        }
        const persistedAssistantContent = replaceAssistantContentTextBlocks(
          [{ type: "text", text: "Generated HTML document" }],
          generatedAssistantMessage,
        );

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
            request: async <T = unknown>() => ({ sessionKey, messages: historyMessages }) as T,
          },
          resolveAgentIdFromSessionKey: (value) => /^agent:([^:]+):/u.exec(value)?.[1] ?? null,
          fetchImpl: async (input, init) => {
            const url = new URL(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            );
            mediaRequests.push(url);
            const source = url.searchParams.get("source");
            expect([attachmentSource, generatedDocumentSource]).toContain(source);
            expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${gatewayToken}`);
            expect(new Headers(init?.headers).get("x-openclaw-agent-id")).toBe(agentId);
            const generated = source === generatedDocumentSource;
            const fileName = generated ? generatedDocumentName : attachmentName;
            const mimeType = generated ? "text/html" : "application/pdf";
            return url.searchParams.get("meta") === "1"
              ? Response.json({
                  available: true,
                  mimeType,
                  mediaTicket: "upstream-ticket-must-not-escape",
                })
              : new Response(generated ? widgetCode : "%PDF-1.4\nowned attachment", {
                  headers: {
                    "Content-Disposition": `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
                    "Content-Type": mimeType,
                  },
                });
          },
        });
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
        });
        const surface = relay.issueSurface({ binding: { agentId } });
        const context = await browser.newContext({ locale, acceptDownloads: true });
        try {
          await context.addCookies([
            { name: "platformclaw_session", value: "browser-token", url: bffOrigin },
          ]);
          const page = await context.newPage();
          const browserMediaRequests: URL[] = [];
          let externalImageRequests = 0;
          await context.route("**/blocked-widget-image.invalid/**", async (route) => {
            externalImageRequests += 1;
            await route.abort();
          });
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
            featureMethods: ["chat.metadata", "chat.startup"],
            historyMessages,
            pluginSurfaceUrls: surface.pluginSurfaceUrls,
            sessionKey,
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
          const frame = preview.frameLocator("iframe");
          await expect
            .poll(() => frame.locator(`[data-proof-target="${target}"]`).textContent())
            .toContain(label);
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
          await expect
            .poll(() =>
              frame
                .locator("[data-blocked-external]")
                .evaluate((element) =>
                  element instanceof HTMLImageElement && element.complete
                    ? element.naturalWidth
                    : -1,
                ),
            )
            .toBe(0);
          expect(externalImageRequests).toBe(0);
          expect(await preview.locator("iframe").getAttribute("src")).toBe(
            `${surface.pluginSurfaceUrls.canvas}${documentPath}`,
          );

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
            expect.arrayContaining([attachmentSource, generatedDocumentSource]),
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
          }
          const downloads = browserMediaRequests.filter(
            (request) => request.searchParams.get("meta") !== "1",
          );
          expect(downloads).toHaveLength(2);
          expect(downloads.map((download) => download.searchParams.get("source"))).toEqual([
            attachmentSource,
            generatedDocumentSource,
          ]);
          for (const download of downloads) {
            expect(download.searchParams.get("sessionKey")).toBe(sessionKey);
            expect(download.searchParams.get("mediaTicket")).toMatch(/^v1\./u);
            expect(download.searchParams.get("mediaTicket")).not.toContain("upstream-ticket");
          }
          expect(mediaRequests.some((request) => request.searchParams.get("meta") === "1")).toBe(
            true,
          );

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
          await page.screenshot({
            path: path.join(proofDir, `${target}.png`),
            fullPage: true,
          });
        } finally {
          await context.close();
          await Promise.all([close(bff), close(gateway)]);
        }
      });
      await rm(stateDir, { recursive: true, force: true });
    },
  );
});
