import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { PlatformClawBrowserMediaRelay } from "../../../packages/platformclaw-control-plane/src/browser-media-http.js";
import { getReplyPayloadMetadata } from "../../../src/auto-reply/reply-payload.js";
import { buildReplyPayloads } from "../../../src/auto-reply/reply/agent-runner-payloads.js";
import { createReplyMediaPathNormalizer } from "../../../src/auto-reply/reply/reply-media-paths.js";
import { replaceSessionEntry } from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.js";
import {
  attachManagedOutgoingMediaToMessage,
  resolveManagedOutgoingMediaArtifactDownload,
  type ManagedOutgoingMediaArtifactDownload,
} from "../../../src/gateway/managed-image-attachments.js";
import { createGatewayHttpServer } from "../../../src/gateway/server-http.js";
import { buildAssistantDisplayContentFromReplyPayloads } from "../../../src/gateway/server-methods/chat-assistant-content.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "../../../src/gateway/server-methods/chat-reply-media.js";
import { appendAssistantTranscriptMessage } from "../../../src/gateway/server-methods/chat-transcript-persistence.js";
import type { GatewayWsClient } from "../../../src/gateway/server/ws-types.js";
import { withAgentMediaContext } from "../../../src/media/agent-media-context.js";
import { getAgentScopedMediaLocalRoots } from "../../../src/media/local-roots.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import type { DocumentPreviewExecutionRuntime } from "../../../test/e2e/platformclaw/document-preview-runtime.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createCanvasExecutionBridge } from "./platformclaw-canvas.test-support.ts";
import {
  createDocumentPreviewFixtures,
  type DocumentPreviewFixture,
  type DocumentPreviewFormat,
} from "./platformclaw-document-preview.test-fixtures.ts";

const agentId = "document-preview-owner";
const sessionKey = `agent:${agentId}:main`;
const gatewayToken = "document-preview-gateway-token";
const browserToken = "document-preview-browser-token";
const proofRoot = path.resolve(".artifacts/control-ui-e2e/platformclaw-canvas/document-previews");

type ObservedMediaResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  bytes: Buffer;
};

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected document-preview TCP address"));
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

async function exerciseDocumentPreview(params: {
  page: Page;
  fixture: DocumentPreviewFixture;
  target: string;
  phase: "initial" | "reloaded" | "recovered";
  proofDir: string;
  mediaResponses: readonly ObservedMediaResponse[];
}): Promise<void> {
  const { page, fixture, target, phase, proofDir, mediaResponses } = params;
  if (fixture.format === "image") {
    const image = page.locator(".chat-message-image");
    await expect
      .poll(() =>
        image.evaluate((element) =>
          element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
        ),
      )
      .toBe(320);
    await image.click();
    const lightbox = page.locator("openclaw-image-lightbox");
    await lightbox.locator(".image").waitFor();
    await expect
      .poll(() =>
        lightbox
          .locator(".image")
          .evaluate((element) =>
            element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
          ),
      )
      .toBe(320);
    await page.screenshot({
      path: path.join(proofDir, `${target}-image-${phase}.png`),
      fullPage: true,
    });
    await lightbox.getByRole("button", { name: "Close image preview" }).click();
    return;
  }
  const card = page
    .locator("openclaw-chat-document-attachment")
    .filter({ hasText: fixture.filename });
  const href = await card
    .getByRole("link", { name: "Download file", exact: true })
    .getAttribute("href");
  if (!href) {
    throw new Error("owned document has no original download URL");
  }
  const expectedUrl = new URL(href, page.url());
  if (fixture.format === "powerpoint") {
    expectedUrl.searchParams.set("preview", "1");
  }
  const [previewResponse] = await Promise.all([
    page.waitForResponse((candidate) => candidate.url() === expectedUrl.href),
    card.getByRole("button", { name: "Preview", exact: true }).click(),
  ]);
  expect(previewResponse.status()).toBe(200);
  const observed = mediaResponses.findLast((candidate) => candidate.url === expectedUrl.href);
  if (!observed) {
    throw new Error("preview did not traverse the real owned BFF relay");
  }
  expect(observed.status).toBe(200);
  expect(observed.headers["content-type"]).toMatch(/^application\/pdf(?:;|$)/u);
  expect(new URL(observed.url).searchParams.get("preview")).toBe(
    fixture.format === "powerpoint" ? "1" : null,
  );
  const pdfBytes = observed.bytes;
  expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
  if (fixture.format === "pdf") {
    expect(pdfBytes).toEqual(fixture.bytes);
  } else {
    expect(pdfBytes).not.toEqual(fixture.bytes);
  }
  const frame = card.locator("iframe.chat-document-attachment__frame");
  await frame.waitFor();
  const previewBlobUrl = await frame.getAttribute("src");
  expect(previewBlobUrl).toMatch(/^blob:/u);
  // Full Chromium's native PDF reader owns these document-load facts. Blob bytes
  // and an iframe alone can otherwise pass while the visible page stays blank.
  await expect
    .poll(async () => {
      const viewerFrame = page
        .frames()
        .find(
          (candidate) =>
            candidate.url().startsWith("chrome-extension://") &&
            candidate.parentFrame()?.url() === previewBlobUrl,
        );
      if (!viewerFrame) {
        return null;
      }
      return viewerFrame.locator("pdf-viewer").evaluate((element) => {
        const dimensions: unknown = Reflect.get(element, "documentDimensions");
        const pages =
          typeof dimensions === "object" &&
          dimensions !== null &&
          "pageDimensions" in dimensions &&
          Array.isArray(dimensions.pageDimensions)
            ? dimensions.pageDimensions.length
            : 0;
        return { state: Reflect.get(element, "loadState_"), pages };
      });
    })
    .toEqual({ state: "success", pages: fixture.format === "powerpoint" ? 2 : 1 });
  await card.scrollIntoViewIfNeeded();
  const layout = await frame.evaluate((element) => {
    const column = element.closest(".chat-group-messages");
    const attachmentCard = element.closest(".chat-assistant-attachment-card");
    if (!(column instanceof HTMLElement) || !(attachmentCard instanceof HTMLElement)) {
      throw new Error("document preview lost its message column");
    }
    const style = getComputedStyle(attachmentCard);
    const inset = [
      "padding-left",
      "padding-right",
      "border-left-width",
      "border-right-width",
    ].reduce((total, property) => total + Number.parseFloat(style.getPropertyValue(property)), 0);
    return { width: element.getBoundingClientRect().width, available: column.clientWidth - inset };
  });
  expect(Math.abs(layout.width - layout.available)).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: path.join(proofDir, `${target}-${fixture.format}-${phase}.png`),
    fullPage: true,
  });
  if (phase === "initial") {
    const desktopViewport = page.viewportSize();
    if (!desktopViewport) {
      throw new Error("document browser proof requires a fixed viewport");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    const bounds = await frame.boundingBox();
    if (!bounds) {
      throw new Error("document preview disappeared at mobile width");
    }
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: path.join(proofDir, `${target}-${fixture.format}-mobile.png`),
      fullPage: true,
    });
    await page.setViewportSize(desktopViewport);
  }
  await card.getByRole("button", { name: "Close preview", exact: true }).click();
  // Click completion does not wait for the component's closed-state render.
  await card.getByRole("button", { name: "Preview", exact: true }).waitFor();
  expect(await card.locator("iframe").count()).toBe(0);
}

/** Normal browser proof and the explicit rootless-Docker suite share the same owner pipeline. */
export function defineDocumentPreviewScenarios(params: {
  formats: readonly DocumentPreviewFormat[];
  sandboxImage?: string;
  createRuntime?: (params: {
    target: "platform_server" | "assigned_vm";
    workspaceDir: string;
    scopeKey: string;
    sandboxImage: string;
  }) => Promise<DocumentPreviewExecutionRuntime>;
}): void {
  const proofDir = path.join(proofRoot, params.createRuntime ? "docker-ssh" : "mapped-bridges");
  describe("PlatformClaw owned document previews", () => {
    let browser: Browser;
    let controlUi: ControlUiE2eServer;
    beforeAll(async () => {
      await mkdir(proofDir, { recursive: true });
      controlUi = await startControlUiE2eServer();
      browser = await chromium.launch({
        executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
      });
    });
    afterAll(async () => {
      await browser?.close();
      await controlUi?.close();
    });
    it.each([
      { label: "Basic", target: "platform_server" },
      { label: "Assigned VM", target: "assigned_vm" },
    ] as const)(
      "previews owned files from $label after source deletion and reload",
      async ({ target }) => {
        const state = await createOpenClawTestState({ prefix: "platformclaw-document-preview-" });
        let execution: DocumentPreviewExecutionRuntime | undefined;
        onTestFinished(async () => {
          try {
            await execution?.cleanup();
          } finally {
            await state.cleanup();
          }
        });
        await withEnvAsync({ OPENCLAW_STATE_DIR: state.stateDir }, async () => {
          const fixtures = await createDocumentPreviewFixtures(params.formats);
          const workspaceDir = path.join(state.stateDir, "gateway-workspace");
          const runtimeDir = path.join(state.stateDir, `${target}-runtime`);
          await Promise.all([
            mkdir(workspaceDir, { recursive: true }),
            mkdir(runtimeDir, { recursive: true }),
          ]);
          const cfg: OpenClawConfig = {
            agents: {
              defaults: params.sandboxImage
                ? { sandbox: { docker: { image: params.sandboxImage } } }
                : undefined,
              entries: { [agentId]: { default: true, workspace: workspaceDir } },
            },
          };
          await state.writeConfig(cfg);
          const runtimeBridge = createCanvasExecutionBridge({
            target,
            workspaceDir: runtimeDir,
            agentWorkspaceDir: workspaceDir,
          });
          if (params.createRuntime) {
            if (!params.sandboxImage) {
              throw new Error("Actual execution proof requires the canonical sandbox image");
            }
            execution = await params.createRuntime({
              target,
              workspaceDir,
              scopeKey: sessionKey,
              sandboxImage: params.sandboxImage,
            });
          }
          const storePath = path.join(state.sessionsDir(agentId), "sessions.json");
          const sessionId = `document-preview-${target}`;
          await replaceSessionEntry(
            { agentId, sessionKey, storePath },
            { sessionId, updatedAt: 1 },
          );
          const historyMessages: unknown[] = [];
          const downloads: Array<{
            fixture: DocumentPreviewFixture;
            download: ManagedOutgoingMediaArtifactDownload;
          }> = [];
          const publishAuthorities: Array<() => Promise<void>> = [];
          for (const fixture of fixtures) {
            const runtimeSource = path.join(runtimeDir, fixture.filename);
            const gatewaySource = path.join(workspaceDir, fixture.filename);
            let runtimePath: string;
            if (execution) {
              runtimePath = await execution.write(fixture.filename, fixture.bytes);
            } else {
              await writeFile(runtimeSource, fixture.bytes);
              runtimePath = `/workspace/${fixture.filename}`;
            }
            await writeFile(gatewaySource, "Gateway fallback must not win");
            const reads: string[] = [];
            const { replyPayloads } = await buildReplyPayloads({
              config: cfg,
              payloads: [{ text: `Owned ${fixture.format}\nMEDIA:${runtimePath}` }],
              isHeartbeat: false,
              didLogHeartbeatStrip: false,
              blockStreamingEnabled: false,
              blockReplyPipeline: null,
              replyToMode: "off",
              normalizeMediaPaths: createReplyMediaPathNormalizer({
                cfg,
                agentId,
                sessionKey,
                workspaceDir,
                ownerScoped: true,
                runtimeSandbox: {
                  outboundFileAccess: {
                    ...execution?.outboundFileAccess,
                    tempDir:
                      execution?.outboundFileAccess.tempDir ?? `/tmp/document-preview-${target}`,
                    readFile: async (request) => {
                      reads.push(request.filePath);
                      return execution
                        ? execution.outboundFileAccess.readFile(request)
                        : runtimeBridge.readFile(request);
                    },
                  },
                },
              }),
            });
            const payload = replyPayloads[0];
            if (!payload?.mediaUrl) {
              throw new Error("MEDIA did not stage the runtime document");
            }
            expect(reads).toEqual([runtimePath]);
            expect(payload.trustedLocalMedia).toBeUndefined();
            expect(getReplyPayloadMetadata(payload)?.stagedLocalMediaUrls).toEqual([
              payload.mediaUrl,
            ]);
            if (execution) {
              const authority = getReplyPayloadMetadata(payload)?.mediaPublishAuthority;
              if (!authority) {
                throw new Error("Runtime staging lost its current publish authority");
              }
              publishAuthorities.push(authority);
              await authority();
            }
            expect(await readFile(payload.mediaUrl)).toEqual(fixture.bytes);
            const normalized = await normalizeWebchatReplyMediaPathsForDisplay({
              cfg,
              agentId,
              sessionKey,
              payloads: replyPayloads,
            });
            const content = await withAgentMediaContext(agentId, () =>
              buildAssistantDisplayContentFromReplyPayloads({
                agentId,
                sessionKey,
                payloads: normalized,
                managedMediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, agentId),
              }),
            );
            const block = content?.find(
              (candidate) => candidate.type === "attachment" || candidate.type === "image",
            );
            const media = isRecord(block?.attachment) ? block.attachment : block;
            if (!content || typeof media?.artifactId !== "string") {
              throw new Error("runtime document did not produce a managed attachment");
            }
            const appended = await appendAssistantTranscriptMessage({
              agentId,
              sessionKey,
              sessionId,
              storePath,
              cfg,
              createIfMissing: true,
              message: `Owned ${fixture.format}`,
              content,
            });
            if (!appended.ok || !appended.messageId) {
              throw new Error("document transcript was not persisted");
            }
            await attachManagedOutgoingMediaToMessage({
              messageId: appended.messageId,
              blocks: content,
            });
            const download = await resolveManagedOutgoingMediaArtifactDownload({
              agentId,
              sessionKey,
              artifactId: media.artifactId,
            });
            if (!download) {
              throw new Error("owned snapshot has no download capability");
            }
            expect(
              await resolveManagedOutgoingMediaArtifactDownload({
                agentId: "another-employee",
                sessionKey,
                artifactId: media.artifactId,
              }),
            ).toBeNull();
            downloads.push({ fixture, download });
            historyMessages.push({
              role: "assistant",
              content,
              __openclaw: { id: appended.messageId },
              timestamp: historyMessages.length + 1,
            });
            await unlink(gatewaySource);
            if (execution) {
              await execution.remove(fixture.filename);
              await expect(
                execution.outboundFileAccess.readFile({
                  filePath: runtimePath,
                  maxBytes: 16 * 1024 * 1024,
                }),
              ).rejects.toThrow();
            } else {
              await unlink(runtimeSource);
              await expect(readFile(runtimeSource)).rejects.toMatchObject({ code: "ENOENT" });
            }
          }
          if (execution) {
            const firstFixture = fixtures[0];
            if (!firstFixture) {
              throw new Error("Actual execution proof requires at least one document fixture");
            }
            execution.revoke();
            await expect(
              execution.outboundFileAccess.readFile({
                filePath: path.posix.join(execution.workspacePath, firstFixture.filename),
                maxBytes: 16 * 1024 * 1024,
              }),
            ).rejects.toThrow("execution target was revoked");
            for (const authority of publishAuthorities) {
              await expect(authority()).rejects.toThrow("execution target was revoked");
            }
          }
          const gateway = createGatewayHttpServer({
            clients: new Set<GatewayWsClient>(),
            controlUiEnabled: false,
            controlUiBasePath: "/__control__",
            openAiChatCompletionsEnabled: false,
            openResponsesEnabled: false,
            handleHooksRequest: async () => false,
            handlePluginRequest: async () => false,
            resolvedAuth: { mode: "token", token: gatewayToken, allowTailscale: false },
            getRuntimeConfig: () => cfg,
          });
          const gatewayOrigin = await listen(gateway);
          let upstreamRequests = 0;
          const mediaRelay = new PlatformClawBrowserMediaRelay({
            gatewayOrigin,
            gatewayAuth: gatewayToken,
            gatewayProxy: {
              resolveAccess: async (token) => ({
                binding: { agentId: token === browserToken ? agentId : "another-employee" },
              }),
              request: async () => {
                throw new Error(
                  "managed snapshot reads do not fetch transcript metadata through RPC",
                );
              },
            },
            resolveAgentIdFromSessionKey: (value) => /^agent:([^:]+):/u.exec(value)?.[1] ?? null,
            fetchImpl: async (input, init) => {
              upstreamRequests++;
              return fetch(input, init);
            },
          });
          const bff = createServer((req, res) => {
            void mediaRelay.handle(req, res).then((handled) => {
              if (!handled) {
                res.statusCode = 404;
                res.end();
              }
            });
          });
          const bffOrigin = await listen(bff);
          const context = await browser.newContext({
            acceptDownloads: true,
            locale: "en-US",
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
          const mediaResponses: ObservedMediaResponse[] = [];
          try {
            await context.addCookies([
              { name: "platformclaw_session", value: browserToken, url: bffOrigin },
            ]);
            await context.route("**/api/chat/media/outgoing/**", async (route) => {
              const url = new URL(route.request().url());
              expect(url.origin).toBe(new URL(controlUi.baseUrl).origin);
              const response = await route.fetch({
                url: `${bffOrigin}${url.pathname}${url.search}`,
              });
              const bytes = await response.body();
              expect(bytes.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
              expect(mediaResponses.length).toBeLessThan(64);
              mediaResponses.push({
                url: url.href,
                status: response.status(),
                headers: response.headers(),
                bytes,
              });
              await route.fulfill({ response, body: bytes });
            });
            await context.route("**/*", async (route) => {
              const request = route.request();
              const navigationUrl = new URL(request.url());
              const chatUrl = new URL("chat", controlUi.baseUrl);
              if (
                !request.isNavigationRequest() ||
                navigationUrl.origin !== chatUrl.origin ||
                navigationUrl.pathname !== chatUrl.pathname ||
                request.frame().parentFrame()
              ) {
                await route.fallback();
                return;
              }
              const response = await route.fetch();
              const body = await response.body();
              const csp = buildControlUiCspHeader({
                inlineScriptHashes: computeInlineScriptHashes(body.toString("utf8")),
              });
              await route.fulfill({
                response,
                body,
                headers: { ...response.headers(), "content-security-policy": csp },
              });
            });
            const page = await context.newPage();
            const gatewayMock = await installMockGateway(page, {
              assistantAgentId: agentId,
              defaultAgentId: agentId,
              historyMessages,
              sessionKey,
              methodResponses: {
                "artifacts.download": {
                  cases: downloads.map(({ download }) => ({
                    match: { sessionKey, artifactId: download.artifactId },
                    response: {
                      artifact: {
                        id: download.artifactId,
                        type: download.type,
                        title: download.title,
                        mimeType: download.mimeType,
                        download: { mode: "url" },
                      },
                      url: new URL(download.url, controlUi.baseUrl).toString(),
                      expiresAt: download.expiresAt,
                    },
                  })),
                },
              },
            });
            await page.goto(`${controlUi.baseUrl}chat`);
            for (const phase of ["initial", "reloaded"] as const) {
              if (phase === "reloaded") {
                await page.reload();
              }
              for (const fixture of fixtures) {
                await exerciseDocumentPreview({
                  page,
                  fixture,
                  target,
                  phase,
                  proofDir,
                  mediaResponses,
                });
              }
            }
            expect(await gatewayMock.getRequests("chat.send")).toHaveLength(0);
            console.log(
              "document-preview-proof",
              JSON.stringify({
                target,
                transport: execution?.transport ?? "mapped-file-bridge",
                formats: params.formats,
                sourceDeleted: true,
                reloaded: true,
              }),
            );
            for (const { fixture, download } of downloads) {
              const original = await context.request.get(
                new URL(download.url, bffOrigin).toString(),
              );
              expect(original.status()).toBe(200);
              expect(await original.body()).toEqual(fixture.bytes);
              if (fixture.format !== "image") {
                const card = page
                  .locator("openclaw-chat-document-attachment")
                  .filter({ hasText: fixture.filename });
                const [originalDownload] = await Promise.all([
                  page.waitForEvent("download"),
                  card.getByRole("link", { name: "Download file", exact: true }).click(),
                ]);
                expect(originalDownload.suggestedFilename()).toBe(fixture.filename);
                const saved = await originalDownload.path();
                if (!saved) {
                  throw new Error("original document download did not complete");
                }
                expect(await readFile(saved)).toEqual(fixture.bytes);
              }
              const foreignContext = await browser.newContext();
              try {
                await foreignContext.addCookies([
                  { name: "platformclaw_session", value: "another-employee-token", url: bffOrigin },
                ]);
                const before = upstreamRequests;
                const deniedUrl = new URL(download.url, bffOrigin);
                deniedUrl.searchParams.set("preview", "1");
                const denied = await foreignContext.request.get(deniedUrl.toString());
                expect(denied.status()).toBe(404);
                expect(upstreamRequests).toBe(before);
                expect((await denied.body()).equals(fixture.bytes)).toBe(false);
              } finally {
                await foreignContext.close();
              }
            }
            const document = fixtures.find((fixture) => fixture.format !== "image");
            if (document) {
              const card = page
                .locator("openclaw-chat-document-attachment")
                .filter({ hasText: document.filename });
              await context.addCookies([
                { name: "platformclaw_session", value: "another-employee-token", url: bffOrigin },
              ]);
              const [denied] = await Promise.all([
                page.waitForResponse(
                  (response) =>
                    new URL(response.url()).pathname.startsWith("/api/chat/media/outgoing/") &&
                    response.status() === 404,
                ),
                card.getByRole("button", { name: "Preview", exact: true }).click(),
              ]);
              expect(denied.status()).toBe(404);
              await card.getByRole("alert").waitFor();
              expect((await card.getByRole("alert").textContent())?.trim()).not.toBe("");
              expect(await card.locator("iframe").count()).toBe(0);
              await page.screenshot({
                path: path.join(proofDir, `${target}-${document.format}-ownership-denied.png`),
                fullPage: true,
              });
              await card.getByRole("button", { name: "Close preview", exact: true }).click();
              await context.addCookies([
                { name: "platformclaw_session", value: browserToken, url: bffOrigin },
              ]);
              await exerciseDocumentPreview({
                page,
                fixture: document,
                target,
                phase: "recovered",
                proofDir,
                mediaResponses,
              });
            }
          } finally {
            await context.close();
            await Promise.all([close(bff), close(gateway)]);
          }
        });
      },
    );
  });
}
