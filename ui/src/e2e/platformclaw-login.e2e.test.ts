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
  guideVideoUrl?: string,
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
  if (guideVideoUrl) {
    // The real ingress injects this deployment metadata; this suite owns UI behavior.
    await page.route("**/platformclaw-login.html", async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      await route.fulfill({
        response,
        body: html.replace(
          "<head>",
          `<head><meta name="platformclaw-guide-video-url" content="${guideVideoUrl}">`,
        ),
      });
    });
  }
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
        expect(await page.locator("[data-login-guide]").isVisible()).toBe(false);
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
          /platformclaw-pixel(?:-[^.]+)?\.svg/,
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

  it.each([
    { name: "desktop-light", mode: "light", width: 1920, height: 1080 },
    { name: "desktop-dark", mode: "dark", width: 1440, height: 900 },
    { name: "mobile", mode: "light", width: 390, height: 844 },
    { name: "landscape", mode: "dark", width: 844, height: 390 },
  ] as const)(
    "keeps the optional video guide secondary and accessible on $name",
    async (variant) => {
      const guideVideoUrl = `${server.baseUrl}guide-fixture.mp4`;
      const { context, page } = await openLogin(variant.mode, variant, guideVideoUrl);
      try {
        let mediaRequests = 0;
        await page.route("**/guide-fixture.mp4", async (route) => {
          mediaRequests += 1;
          await route.fulfill({ status: 404, body: "Missing fixture video" });
        });
        const guide = page.getByRole("button", { name: "가이드 영상 보기" });
        expect(await guide.isVisible()).toBe(true);
        const card = await page.locator(".login-card").boundingBox();
        const guideBox = await guide.boundingBox();
        expect(card).not.toBeNull();
        expect(guideBox).not.toBeNull();
        expect(guideBox!.y).toBeGreaterThanOrEqual(card!.y + card!.height);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(variant.width);
        expect(mediaRequests).toBe(0);
        const account = page.locator('input[name="identifier"]');
        await account.fill("person.one");
        await screenshot(page, `guide-${variant.name}.png`);
        await guide.click();
        const dialog = page.getByRole("dialog", { name: "PlatformClaw 사용 가이드" });
        expect(await dialog.isVisible()).toBe(true);
        const close = page.getByRole("button", { name: "영상 닫기" });
        expect(await close.evaluate((element) => element === document.activeElement)).toBe(true);
        const dialogBox = await dialog.boundingBox();
        expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
        expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(variant.width);
        expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(variant.height);
        expect(
          await page.locator("video").evaluate((video) => (video as HTMLVideoElement).paused),
        ).toBe(true);
        await expect.poll(() => page.locator("[data-login-guide-error]").isVisible()).toBe(true);
        expect(mediaRequests).toBeGreaterThan(0);
        const external = page.getByRole("link", { name: "새 탭에서 열기" });
        expect(await external.getAttribute("href")).toBe(guideVideoUrl);
        expect(await external.getAttribute("rel")).toBe("noopener noreferrer");
        await screenshot(page, `guide-dialog-${variant.name}.png`);
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
          true,
        );
        await page.keyboard.press("Escape");
        expect(await dialog.isVisible()).toBe(false);
        // Native dialog close events are queued after the modal leaves the top layer.
        await expect.poll(() => page.locator("video").getAttribute("src")).toBeNull();
        expect(await guide.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await account.inputValue()).toBe("person.one");
        expect(await account.isEnabled()).toBe(true);
        await guide.click();
        await close.click();
        expect(await dialog.isVisible()).toBe(false);
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

  it("returns keyboard focus to the password after rejected credentials", async () => {
    const { context, page } = await openLogin("light", { width: 390, height: 844 });
    try {
      await page.route("**/platformclaw/api/auth/login", (route) =>
        route.fulfill({ status: 401, json: { authenticated: false } }),
      );
      await page.locator('input[name="identifier"]').fill("person.one");
      const password = page.locator('input[name="password"]');
      await password.fill("fixture");
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      await page.getByRole("alert").waitFor();
      expect(await password.inputValue()).toBe("");
      expect(await password.isEnabled()).toBe(true);
      expect(await password.evaluate((element) => document.activeElement === element)).toBe(true);
      await screenshot(page, "mobile-login-retry-focus.png");
    } finally {
      await context.close();
    }
  });

  it("validates inputs, recovers from rejected logins, and follows login links on PC", async () => {
    const { context, page } = await openLogin("light", { width: 1440, height: 900 });
    try {
      let status = 401;
      let requestCount = 0;
      await page.route("**/platformclaw/api/auth/login", async (route) => {
        requestCount += 1;
        await route.fulfill({ status, json: { authenticated: status === 200 } });
      });
      const account = page.locator('input[name="identifier"]');
      const password = page.locator('input[name="password"]');
      const submit = page.getByRole("button", { name: "로그인", exact: true });
      await submit.click();
      expect(
        await account.evaluate((input) => (input as HTMLInputElement).validity.valueMissing),
      ).toBe(true);
      expect(requestCount).toBe(0);
      await account.fill("person.one");
      await submit.click();
      expect(
        await password.evaluate((input) => (input as HTMLInputElement).validity.valueMissing),
      ).toBe(true);
      expect(requestCount).toBe(0);
      for (const [nextStatus, message] of [
        [401, "아이디 또는 비밀번호"],
        [403, "현재 계정"],
        [409, "로그인 세션 수"],
        [429, "로그인 시도가 많습니다"],
        [503, "로그인하지 못했습니다"],
      ] as const) {
        status = nextStatus;
        await password.fill("fixture-only");
        await password.press("Enter");
        await expect.poll(() => page.getByRole("alert").textContent()).toContain(message);
        expect(await password.inputValue()).toBe("");
        expect(await password.evaluate((input) => document.activeElement === input)).toBe(true);
      }
      await screenshot(page, "PC-login-rejected.png");
      await page.route("**/platformclaw/app/chat", (route) =>
        route.fulfill({ contentType: "text/html", body: "<h1>Fixture workspace</h1>" }),
      );
      status = 200;
      await password.fill("fixture-only");
      await submit.click();
      await page.getByRole("heading", { name: "Fixture workspace" }).waitFor();
      await page.goto(`${server.baseUrl}platformclaw-login.html`);
      await page.route("**/employee/auth/adsso?**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<h1>Fixture SSO</h1>" }),
      );
      await page.getByRole("link", { name: "ADSSO 로그인" }).click();
      await page.getByRole("heading", { name: "Fixture SSO" }).waitFor();
    } finally {
      await context.close();
    }
  });
});
