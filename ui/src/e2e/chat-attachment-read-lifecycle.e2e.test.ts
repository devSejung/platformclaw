import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import {
  createPlatformClawWebAssetHandler,
  PLATFORMCLAW_WEB_TERMINAL_ENABLED,
} from "../../../packages/platformclaw-control-plane/src/web-assets.ts";
import {
  canRunPlaywrightChromium,
  buildProductionControlUiE2e,
  controlUiSessionUrl,
  installMockGateway as installControlUiMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  type ControlUiE2eServer,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgWFoGAAHEARwpe8UhAAAAAElFTkSuQmCC";
const DROPPED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNYylAGAAJpARy2Uir0AAAAAElFTkSuQmCC";
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.resolve(".artifacts/control-ui-e2e/clipboard-image-preview-csp");

function installMockGateway(page: Page, scenario: ControlUiMockGatewayScenario = {}) {
  return installControlUiMockGateway(page, {
    basePath: "/platformclaw/app",
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    terminalEnabled: PLATFORMCLAW_WEB_TERMINAL_ENABLED,
    ...scenario,
  });
}

async function newPage() {
  const viewport = { height: 900, width: 1280 };
  const context = await browser.newContext({
    locale: "en-US",
    ...(captureUiProof ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
    serviceWorkers: "block",
    viewport,
  });
  const page = await context.newPage();
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          accountId: "preview.one",
          displayName: "Preview One",
          department: "Platform Lab",
          globalRole: "member",
        },
        agent: { agentId: "main", state: "active" },
        session: { idleExpiresAt: Date.now() + 60_000, absoluteExpiresAt: Date.now() + 120_000 },
      },
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("platformclaw.product-tour.v1.completed", "true");
    const violations: string[] = [];
    (globalThis as unknown as { imageCspViolations: string[] }).imageCspViolations = violations;
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.effectiveDirective === "img-src") {
        violations.push(event.blockedURI);
      }
    });
  });
  return { context, page };
}

async function expectImagesLoaded(images: Locator, count: number): Promise<void> {
  await expect.poll(() => images.count()).toBe(count);
  await expect
    .poll(() =>
      images.evaluateAll((elements) =>
        elements.every((element) => {
          const image = element as HTMLImageElement;
          return image.complete && image.naturalWidth > 0;
        }),
      ),
    )
    .toBe(true);
  await images.evaluateAll((elements) =>
    Promise.all(elements.map((element) => (element as HTMLImageElement).decode())),
  );
}

async function expectNoImageCspViolations(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => (globalThis as unknown as { imageCspViolations: string[] }).imageCspViolations,
    ),
  ).toEqual([]);
}

async function capturePreview(page: Page, name: string): Promise<void> {
  if (captureUiProof) {
    await page.screenshot({ path: path.join(proofDir, `${name}.png`), fullPage: true });
  }
}

type DeferredAttachmentProof = {
  aborts: number;
  finish: (() => void) | undefined;
};

async function installDeferredAttachmentReader(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proof = { aborts: 0, finish: undefined as (() => void) | undefined };
    (globalThis as unknown as { attachmentReadProof: typeof proof }).attachmentReadProof = proof;
    // Keep the native methods before overriding them so deferred completion and
    // cancellation cannot recursively call their own test hooks.
    const readAsDataURL = Reflect.get(
      FileReader.prototype,
      "readAsDataURL",
    ) as FileReader["readAsDataURL"];
    const abort = Reflect.get(FileReader.prototype, "abort") as FileReader["abort"];
    FileReader.prototype.readAsDataURL = function (blob: Blob) {
      proof.finish = () => readAsDataURL.call(this, blob);
    };
    FileReader.prototype.abort = function () {
      proof.aborts += 1;
      return abort.call(this);
    };
  });
}

async function pastePng(composer: Locator): Promise<void> {
  await composer.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
  }, ONE_PIXEL_PNG_B64);
}

let browser: Browser;
let server: ControlUiE2eServer;
let buildDirectory: string | undefined;

describeControlUiE2e("Control UI chat attachment read lifecycle", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    buildDirectory = await mkdtemp(path.join(tmpdir(), "platformclaw-employee-preview-"));
    await buildProductionControlUiE2e(buildDirectory, "employee-image-preview");
    const [{ build }, { default: loginConfig }] = await Promise.all([
      import("vite"),
      import("../../vite.platformclaw-login.config.ts"),
    ]);
    await build({
      ...loginConfig({ outDir: buildDirectory }),
      configFile: false,
      logLevel: "error",
      root: fileURLToPath(new URL("../..", import.meta.url)),
    });
    if (captureUiProof) {
      await mkdir(proofDir, { recursive: true });
    }
    // Serve the production bundle through the employee document owner. Vite's
    // preview server and the regular Gateway use different CSP policies.
    const httpServer = createServer((req, res) => {
      void (async () => {
        if (!(await assets.handlePublic(req, res)) && !(await assets.handleApplication(req, res))) {
          res.writeHead(404).end();
        }
      })().catch(() => res.writeHead(500).end());
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Employee web server did not expose a TCP port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    server = {
      baseUrl: `${origin}/platformclaw/app/`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        }),
    };
    let assets: ReturnType<typeof createPlatformClawWebAssetHandler>;
    try {
      assets = createPlatformClawWebAssetHandler(buildDirectory, { publicOrigin: origin });
    } catch (error) {
      await server.close();
      throw error;
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (buildDirectory) {
      await rm(buildDirectory, { recursive: true, force: true });
    }
  });

  it("waits for a pasted image before sending its complete gateway payload", async () => {
    const { context, page } = await newPage();
    await installDeferredAttachmentReader(page);
    const gateway = await installMockGateway(page);

    try {
      const response = await page.goto(`${server.baseUrl}chat`);
      await capturePreview(page, "employee-chat");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const send = page.getByRole("button", { name: "Send message" });
      await composer.fill("Include the image that is still loading");
      await pastePng(composer);

      await expect.poll(() => send.isDisabled()).toBe(true);
      await composer.press("Enter");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await page.evaluate(() => {
        const proof = (globalThis as unknown as { attachmentReadProof: DeferredAttachmentProof })
          .attachmentReadProof;
        if (!proof.finish) {
          throw new Error("Pasted image read was not started");
        }
        proof.finish();
      });
      const preview = page.locator('.chat-attachment-thumb img[alt="Attachment preview"]');
      await preview.waitFor();
      expect(await preview.getAttribute("src")).toMatch(/^blob:/u);
      await capturePreview(page, "pasted-preview");
      await expectImagesLoaded(preview, 1);
      expect(response?.headers()["content-security-policy"]).toContain(
        "img-src 'self' data: blob:",
      );
      await expectNoImageCspViolations(page);
      await expect.poll(() => send.isEnabled()).toBe(true);
      await send.click();

      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        attachments: [{ content: ONE_PIXEL_PNG_B64, fileName: "pixel.png", mimeType: "image/png" }],
        message: "Include the image that is still loading",
      });
    } finally {
      await context.close();
    }
  });

  it.each(["new", "existing"] as const)(
    "loads pasted, selected, and dropped images in the %s employee composer",
    async (composerKind) => {
      const { context, page } = await newPage();
      const isNew = composerKind === "new";
      const sessionKey = "agent:main:employee-image-preview";
      const gateway = await installMockGateway(page, {
        ...(isNew
          ? {
              methodResponses: {
                "sessions.create": {
                  key: sessionKey,
                  runId: "image-preview-run",
                  runStarted: true,
                  messageSeq: 1,
                },
              },
            }
          : {}),
      });

      try {
        await page.goto(`${server.baseUrl}${isNew ? "new" : "chat"}`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const previews = page.locator('.chat-attachment-thumb img[alt="Attachment preview"]');
        await composer.fill("Keep the original PNG bytes");
        await capturePreview(page, `${composerKind}-composer`);
        await pastePng(composer);
        await expectImagesLoaded(previews, 1);
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "selected.png",
          mimeType: "image/png",
          buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
        });
        await expectImagesLoaded(previews, 2);
        await composer.evaluate((element, base64) => {
          const transfer = new DataTransfer();
          transfer.items.add(
            new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], "dropped.png", {
              type: "image/png",
            }),
          );
          element.dispatchEvent(
            new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
          );
        }, DROPPED_PNG_B64);

        await expectImagesLoaded(previews, 3);
        expect(
          await previews.evaluateAll((images) =>
            images.every((image) => image.getAttribute("src")?.startsWith("blob:")),
          ),
        ).toBe(true);
        await capturePreview(page, `${composerKind}-three-previews`);
        await page.getByRole("button", { name: "Remove attachment" }).nth(1).click();
        await expectImagesLoaded(previews, 2);
        await expectNoImageCspViolations(page);

        // The mock has no persistence owner. Return the expected saved turn on
        // the post-send history refresh, as the real Gateway would.
        await gateway.setHistoryMessages([
          {
            role: "user",
            content: [
              { type: "text", text: "Keep the original PNG bytes" },
              ...[ONE_PIXEL_PNG_B64, DROPPED_PNG_B64].map((data) => ({
                type: "image",
                source: { type: "base64", media_type: "image/png", data },
              })),
            ],
            timestamp: Date.now(),
            __openclaw: { id: "saved-image-prompt", seq: 1 },
          },
        ]);
        await page.getByRole("button", { name: isNew ? "Start thread" : "Send message" }).click();
        const request = await gateway.waitForRequest(isNew ? "sessions.create" : "chat.send");
        if (!isRecord(request.params)) {
          throw new Error("Expected chat request parameters");
        }
        expect(request.params).toMatchObject({
          message: "Keep the original PNG bytes",
          attachments: [
            {
              type: "image",
              fileName: "pixel.png",
              mimeType: "image/png",
              content: ONE_PIXEL_PNG_B64,
            },
            {
              type: "image",
              fileName: "dropped.png",
              mimeType: "image/png",
              content: DROPPED_PNG_B64,
            },
          ],
        });
        await gateway.emitChatFinal({
          runId: isNew ? "image-preview-run" : String(request.params.idempotencyKey),
          sessionKey: isNew ? sessionKey : String(request.params.sessionKey),
          text: "Images received",
        });
        await expectImagesLoaded(page.locator(".chat-group.user img.chat-message-image"), 2);
        await expectNoImageCspViolations(page);
        await capturePreview(page, `${composerKind}-sent-images`);
      } finally {
        await context.close();
      }
    },
  );

  it("aborts a session's pending image before the pane adopts another session", async () => {
    const firstSession = "agent:main:attachment-session-a";
    const secondSession = "agent:main:attachment-session-b";
    const { context, page } = await newPage();
    await installDeferredAttachmentReader(page);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          count: 2,
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            { key: firstSession, kind: "direct", updatedAt: 2 },
            { key: secondSession, kind: "direct", updatedAt: 1 },
          ],
          ts: Date.now(),
        },
      },
      sessionKey: firstSession,
    });

    try {
      await page.goto(controlUiSessionUrl(server.baseUrl, firstSession));
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Private session A attachment");
      await pastePng(composer);
      await expect
        .poll(() => page.getByRole("button", { name: "Send message" }).isDisabled())
        .toBe(true);

      await page.locator("openclaw-chat-pane").evaluate((pane, sessionKey) => {
        (pane as HTMLElement & { sessionKey: string }).sessionKey = sessionKey;
      }, secondSession);

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (globalThis as unknown as { attachmentReadProof: DeferredAttachmentProof })
                .attachmentReadProof.aborts,
          ),
        )
        .toBe(1);
      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);

      await composer.fill("Safe session B message");
      await composer.press("Enter");
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        message: "Safe session B message",
        sessionKey: secondSession,
      });
      expect((request.params as { attachments?: unknown }).attachments).toBeUndefined();
    } finally {
      await context.close();
    }
  });
});
