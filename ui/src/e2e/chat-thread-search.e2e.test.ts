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
          { role: "assistant", content: [{ type: "text", text: "Search target alpha." }] },
          { role: "assistant", content: [{ type: "text", text: "Unrelated message beta." }] },
        ],
      });
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await gateway.waitForRequest("connect");
      await page.getByText("Unrelated message beta.", { exact: true }).waitFor();
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await composer.focus();
      await page.keyboard.press("Control+f");
      const search = page.locator(".agent-chat__search-bar");
      await search.waitFor({ state: "visible" });
      if (captureProof) {
        await page.screenshot({ path: path.join(proofDir, `search-open-${width}.png`) });
      }
      const icon = await search.locator(":scope > svg").boundingBox();
      const bar = await search.boundingBox();
      const input = await search.locator("input").boundingBox();
      expect(icon).not.toBeNull();
      expect(bar).not.toBeNull();
      expect(input).not.toBeNull();
      expect(icon!.width).toBeLessThanOrEqual(20);
      expect(icon!.height).toBeLessThanOrEqual(20);
      expect(bar!.height).toBeLessThanOrEqual(64);
      expect(input!.width).toBeGreaterThan(80);
      expect(input!.x).toBeGreaterThanOrEqual(icon!.x + icon!.width);
      expect(input!.x + input!.width).toBeLessThanOrEqual(bar!.x + bar!.width);

      await search.locator("input").fill("alpha");
      await expect
        .poll(() => page.getByText("Search target alpha.", { exact: true }).isVisible())
        .toBe(true);
      await expect
        .poll(() => page.getByText("Unrelated message beta.", { exact: true }).isVisible())
        .toBe(false);
      await search.getByRole("button", { name: "Close search" }).click();
      await search.waitFor({ state: "hidden" });
      await expect
        .poll(() => page.getByText("Unrelated message beta.", { exact: true }).isVisible())
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
