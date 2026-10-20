import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

let browser: Browser;
let server: ControlUiE2eServer;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts/control-ui-e2e/chat-thread-search");

describe("chat thread search", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
    server = await startControlUiE2eServer();
    if (captureProof) {
      await mkdir(proofDir, { recursive: true });
    }
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([1280, 390])("keeps Ctrl+F search compact at viewport width %i", async (width) => {
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width, height: 720 },
      ...(captureProof ? { recordVideo: { dir: proofDir, size: { width, height: 720 } } } : {}),
    });
    try {
      const page = await context.newPage();
      const sessionKey = "agent:main:search-proof";
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: [
          {
            role: "assistant",
            __openclaw: { id: "alpha", seq: 1 },
            content: [{ type: "text", text: "Search target alpha." }],
          },
          {
            role: "assistant",
            __openclaw: { id: "beta", seq: 2 },
            content: [{ type: "text", text: "Unrelated message beta." }],
          },
        ],
        methodResponses: {
          "sessions.search": {
            results: [
              {
                sessionKey,
                sessionId: "control-ui-e2e-session",
                messageId: "alpha",
                role: "assistant",
                timestamp: 1,
                snippet: "Search target alpha.",
                score: 0,
              },
            ],
            totalCount: 1,
            hasMore: false,
          },
        },
      });
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await gateway.waitForRequest("connect");
      await page.getByRole("paragraph").filter({ hasText: "Unrelated message beta." }).waitFor();
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await composer.fill("Unsent draft");
      await composer.focus();
      await page.keyboard.press("Control+f");
      const search = page.locator(".agent-chat__search-bar");
      await search.waitFor({ state: "visible" });
      await expect
        .poll(() => search.locator("input").evaluate((input) => input === document.activeElement))
        .toBe(true);
      if (captureProof) {
        await page.screenshot({ path: path.join(proofDir, `search-open-${width}.png`) });
      }
      const icon = await search.locator(":scope > svg").boundingBox();
      const bar = await search.boundingBox();
      const inputBounds = await search.locator("input").boundingBox();
      expect(icon).not.toBeNull();
      expect(bar).not.toBeNull();
      expect(inputBounds).not.toBeNull();
      expect(icon!.width).toBeLessThanOrEqual(20);
      expect(icon!.height).toBeLessThanOrEqual(20);
      expect(bar!.height).toBeLessThanOrEqual(64);
      expect(inputBounds!.width).toBeGreaterThan(80);
      expect(inputBounds!.x).toBeGreaterThanOrEqual(icon!.x + icon!.width);
      expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(bar!.x + bar!.width);

      await search.locator("input").fill("alpha");
      await gateway.waitForRequest("sessions.search");
      await expect.poll(() => search.getByRole("status").textContent()).toContain("1 / 1");
      await expect
        .poll(() =>
          page.getByRole("paragraph").filter({ hasText: "Search target alpha." }).isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page.getByRole("paragraph").filter({ hasText: "Unrelated message beta." }).isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => CSS.highlights.get("openclaw-search")?.size ?? 0))
        .toBeGreaterThan(0);
      await page.keyboard.press("Control+f");
      expect(await search.isVisible()).toBe(true);
      expect(await search.locator("input").inputValue()).toBe("alpha");
      await page.keyboard.press("Escape");
      await search.waitFor({ state: "hidden" });
      expect(await composer.inputValue()).toBe("Unsent draft");
      expect(await composer.evaluate((input) => input === document.activeElement)).toBe(true);
      await expect
        .poll(() =>
          page.getByRole("paragraph").filter({ hasText: "Unrelated message beta." }).isVisible(),
        )
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
