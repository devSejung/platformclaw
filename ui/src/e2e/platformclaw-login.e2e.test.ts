import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const captureVideo = process.env.OPENCLAW_CAPTURE_UI_VIDEO === "1";
const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "platformclaw-login");

let browser: Browser;
let server: ControlUiE2eServer;

async function openLogin(
  colorScheme: "light" | "dark",
  viewport: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    colorScheme,
    locale: "ko-KR",
    recordVideo: captureVideo
      ? { dir: path.join(artifactDir, "video"), size: viewport }
      : undefined,
    serviceWorkers: "block",
    viewport,
  });
  const page = await context.newPage();
  await page.route("**/platformclaw/api/auth/session", async (route) => {
    await route.fulfill({ contentType: "application/json", body: '{"authenticated":false}' });
  });
  await page.goto(`${server.baseUrl}platformclaw-login.html`);
  const identifier = page.locator('input[name="identifier"]');
  await identifier.waitFor();
  await expect.poll(() => identifier.isEnabled()).toBe(true);
  return { context, page };
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (!captureProof) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, name) });
}

describeE2e("PlatformClaw login", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(["light", "dark"] as const)(
    "renders the themed desktop surface in %s mode",
    async (mode) => {
      const { context, page } = await openLogin(mode, { width: 1440, height: 960 });
      try {
        const hero = page.locator("[data-login-hero] .hero");
        await hero.waitFor();
        expect(await hero.isVisible()).toBe(true);
        expect(await page.locator("[data-login-mascot] svg").getAttribute("viewBox")).toBe(
          "0 0 66 66",
        );
        const layout = await page.evaluate(() => {
          const mascot = document.querySelector<SVGSVGElement>("[data-login-mascot] svg");
          const card = document.querySelector<HTMLElement>(".login-card");
          if (!mascot || !card) {
            throw new Error("Missing login surface");
          }
          const mascotBox = mascot.getBoundingClientRect();
          const cardBox = card.getBoundingClientRect();
          const heroScene = document
            .querySelector<HTMLElement>("[data-login-hero]")
            ?.shadowRoot?.querySelector<HTMLElement>(".scene");
          return {
            background: getComputedStyle(document.body).backgroundColor,
            cardRight: cardBox.right,
            heroLayersFit:
              heroScene !== null &&
              heroScene !== undefined &&
              Array.from(heroScene.querySelectorAll<HTMLElement>(".layer")).every(
                (layer) => layer.scrollHeight <= layer.clientHeight,
              ),
            mascotHeight: mascotBox.height,
            mascotWidth: mascotBox.width,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        expect(layout.background).toBe(mode === "light" ? "rgb(250, 249, 245)" : "rgb(24, 23, 21)");
        expect(layout.heroLayersFit).toBe(true);
        expect(layout.mascotHeight).toBe(132);
        expect(layout.mascotWidth).toBe(132);
        expect(layout.cardRight).toBeLessThanOrEqual(1440);
        expect(layout.overflow).toBe(0);
        expect(await page.locator('link[rel="icon"]').getAttribute("href")).toMatch(
          /platformclaw-pixel\.svg/,
        );
        const adssoLogin = page.getByRole("link", { name: "ADSSO 로그인" });
        expect(await adssoLogin.isVisible()).toBe(true);
        expect(await adssoLogin.getAttribute("href")).toBe(
          "/employee/auth/adsso?returnTo=%2Fplatformclaw%2Fapp%2Fchat",
        );
        await screenshot(page, `desktop-${mode}.png`);
      } finally {
        await context.close();
      }
    },
  );

  it("keeps login first and interaction intact on mobile", async () => {
    const { context, page } = await openLogin("light", { width: 390, height: 844 });
    try {
      const card = page.locator(".login-card");
      const hero = page.locator("[data-login-hero]");
      expect(await card.isVisible()).toBe(true);
      expect(await hero.isVisible()).toBe(false);
      expect(await page.getByRole("link", { name: "ADSSO 로그인" }).isVisible()).toBe(true);

      await page.mouse.move(360, 100);
      const idleX = await page
        .locator("[data-login-mascot]")
        .evaluate((element) =>
          Number.parseInt((element as HTMLElement).style.getPropertyValue("--mascot-x"), 10),
        );
      expect(idleX).toBeGreaterThan(0);
      expect(idleX % 2).toBe(0);

      await page.locator('input[name="identifier"]').fill("person.one");
      await expect
        .poll(() => page.locator("[data-login-mascot]").getAttribute("data-login-mascot-mode"))
        .toBe("account");
      await page.locator('input[name="password"]').focus();
      await expect
        .poll(() => page.locator("[data-login-mascot]").getAttribute("data-login-mascot-mode"))
        .toBe("password");
      expect(
        await page
          .locator("[data-login-mascot]")
          .evaluate((element) => (element as HTMLElement).style.getPropertyValue("--eye-open")),
      ).toBe("0.25");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await screenshot(page, "mobile-light-password.png");
    } finally {
      await context.close();
    }
  });

  it("keeps the tablet breakpoint focused on authentication", async () => {
    const { context, page } = await openLogin("light", { width: 900, height: 900 });
    try {
      expect(await page.locator("[data-login-hero]").isVisible()).toBe(false);
      expect(await page.locator(".login-card").isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(900);
    } finally {
      await context.close();
    }
  });
});
