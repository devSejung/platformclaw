// Control UI tests cover the downstream default theme against a mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const captureUiVideoEnabled = process.env.OPENCLAW_CAPTURE_UI_VIDEO === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "platformclaw-theme",
);

let browser: Browser;
let server: ControlUiE2eServer;

async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(uiProofArtifactDir, fileName),
  });
}

describeControlUiE2e("PlatformClaw theme mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("boots fresh profiles on cream surfaces and keeps code chrome charcoal", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: captureUiVideoEnabled
        ? { dir: path.join(uiProofArtifactDir, "video"), size: { height: 900, width: 1440 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "PlatformClaw product surface:",
                "```ts",
                'const theme = { canvas: "#faf9f5", primary: "#0f7c72", productSurface: "#181715" };',
                "export function resolveTheme() {",
                "  return theme;",
                "}",
                "```",
              ].join("\n"),
            },
          ],
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}settings/appearance`);
      const platformClawTheme = page.getByRole("button", { name: "PlatformClaw", exact: true });
      await platformClawTheme.waitFor();
      await expect.poll(() => platformClawTheme.getAttribute("class")).toContain("--active");
      const appearance = await page.evaluate(() => {
        const group = document.querySelector<HTMLElement>(".settings-group");
        if (!group) {
          throw new Error("Missing settings surface");
        }
        const root = document.documentElement;
        return {
          body: getComputedStyle(document.body).backgroundColor,
          card: getComputedStyle(group).backgroundColor,
          mode: root.dataset.themeMode,
          radius: getComputedStyle(root).getPropertyValue("--radius-lg").trim(),
          theme: root.dataset.theme,
        };
      });
      expect(appearance).toEqual({
        body: "rgb(250, 249, 245)",
        card: "rgb(239, 233, 222)",
        mode: "light",
        radius: "12px",
        theme: "platformclaw-light",
      });
      await captureUiProof(page, "01-appearance.png");

      await page.goto(`${server.baseUrl}chat`);
      const codeWindow = page.locator(".code-block-wrapper pre").first();
      await codeWindow.waitFor();
      const codeSurface = await codeWindow.evaluate((element) => {
        const styles = getComputedStyle(element);
        return {
          background: styles.backgroundColor,
          border: styles.borderTopColor,
          color: styles.color,
          overflowX: styles.overflowX,
        };
      });
      expect(codeSurface).toEqual({
        background: "rgb(31, 30, 27)",
        border: "rgb(53, 50, 46)",
        color: "rgb(250, 249, 245)",
        overflowX: "auto",
      });
      await captureUiProof(page, "02-chat-code-surface.png");

      await page.setViewportSize({ height: 844, width: 390 });
      await page.goto(`${server.baseUrl}settings/appearance`);
      const mobileThemeCard = page.getByRole("button", { name: "PlatformClaw", exact: true });
      await mobileThemeCard.waitFor();
      const mobileThemeCardBox = await mobileThemeCard.boundingBox();
      expect(mobileThemeCardBox?.height).toBeGreaterThanOrEqual(44);
      expect(mobileThemeCardBox?.width).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        "rgb(250, 249, 245)",
      );
      await captureUiProof(page, "03-appearance-mobile.png");

      await page.goto(`${server.baseUrl}chat`);
      const mobileCodeWindow = page.locator(".code-block-wrapper pre").first();
      await mobileCodeWindow.waitFor();
      expect(
        await mobileCodeWindow.evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(true);
      await captureUiProof(page, "04-chat-code-surface-mobile.png");
    } finally {
      await context.close();
    }
  });
});
