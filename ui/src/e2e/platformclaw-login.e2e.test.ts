import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  currentGatewaySelectionKeyForPage,
  settingsKeyForGateway,
} from "../app/settings-storage.ts";
import type { ThemeMode, ThemeName } from "../app/theme.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const captureVideo = process.env.OPENCLAW_CAPTURE_UI_VIDEO === "1";
const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "platformclaw-login");

let browser: Browser;
let server: ControlUiE2eServer;

type LoginAppearance = {
  theme?: ThemeName;
  themeMode?: ThemeMode;
  customTheme?: ReturnType<typeof createImportedCustomThemeFixture>;
  reducedMotion?: "reduce" | "no-preference";
};

function appearanceStorage() {
  const url = new URL("/platformclaw/app", server.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const gatewayUrl = url.href;
  return {
    gatewayUrl,
    settingsKey: settingsKeyForGateway(gatewayUrl),
    selectionKey: currentGatewaySelectionKeyForPage(gatewayUrl),
  };
}

async function openLogin(
  colorScheme: "light" | "dark",
  viewport: { width: number; height: number },
  guideVideoUrl?: string,
  appearance: LoginAppearance = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const scopedStorage = appearanceStorage();
  const context = await browser.newContext({
    colorScheme,
    reducedMotion: appearance.reducedMotion ?? "no-preference",
    locale: "ko-KR",
    recordVideo: captureVideo
      ? { dir: path.join(artifactDir, "video"), size: viewport }
      : undefined,
    serviceWorkers: "block",
    viewport,
  });
  // Reproduce the original order: the app persists its selected Gateway's
  // appearance before the separate login document bootstraps.
  await context.addInitScript(
    ({ storage, preferences }) => {
      if (!localStorage.getItem(storage.settingsKey)) {
        localStorage.setItem(storage.settingsKey, JSON.stringify(preferences));
        localStorage.setItem(storage.selectionKey, storage.gatewayUrl);
      }
      new MutationObserver((records, observer) => {
        if (records.some((record) => record.target === document.documentElement)) {
          document.documentElement.dataset.themeAppliedAt = String(performance.now());
          observer.disconnect();
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-theme"] });
      new PerformanceObserver((entries) => {
        const firstPaint = entries
          .getEntries()
          .find((entry) => entry.name === "first-contentful-paint");
        if (firstPaint) {
          document.documentElement.dataset.firstPaintAt = String(firstPaint.startTime);
          document.documentElement.dataset.firstPaintTheme = document.documentElement.dataset.theme;
        }
      }).observe({ type: "paint", buffered: true });
    },
    {
      storage: scopedStorage,
      preferences: {
        gatewayUrl: scopedStorage.gatewayUrl,
        theme: appearance.theme ?? "platformclaw",
        themeMode: appearance.themeMode ?? colorScheme,
        customTheme: appearance.customTheme,
      },
    },
  );
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
  const notice = page.getByRole("complementary", { name: "보안 안내 / Security notice" });
  expect(await notice.isVisible()).toBe(true);
  expect(await notice.locator('p[lang="ko"]').isVisible()).toBe(true);
  expect(await notice.locator('p[lang="en"]').isVisible()).toBe(true);
  const noticeBox = await notice.boundingBox();
  const accessBox = await page.locator(".login-access").boundingBox();
  expect(noticeBox).not.toBeNull();
  expect(accessBox).not.toBeNull();
  expect(noticeBox!.y).toBeGreaterThanOrEqual(accessBox!.y + accessBox!.height);
  expect(
    await notice.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      border: getComputedStyle(element).borderTopWidth,
    })),
  ).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px" });
  expect(noticeBox!.x).toBeGreaterThanOrEqual(0);
  expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(viewport.width);

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

async function expectThemedFirstPaint(page: Page, theme: string): Promise<void> {
  await expect.poll(() => page.locator("html").getAttribute("data-first-paint-theme")).toBe(theme);
  const timing = await page.locator("html").evaluate((root) => ({
    applied: Number((root as HTMLElement).dataset.themeAppliedAt),
    painted: Number((root as HTMLElement).dataset.firstPaintAt),
  }));
  // Paint observer delivery can happen after bootstrap; compare the paint's
  // own timestamp with the theme mutation, not only its later callback state.
  expect(timing.applied).toBeGreaterThan(0);
  expect(timing.applied).toBeLessThanOrEqual(timing.painted);
}

async function heroFrame(page: Page, time: number) {
  return page.locator("[data-login-hero] .hero").evaluate((hero, currentTime) => {
    const animations = hero.getAnimations({ subtree: true });
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = currentTime;
    }
    const svg = hero.querySelector<SVGSVGElement>("svg.workspace")!;
    const content = svg.getBBox();
    const bounds = hero.getBoundingClientRect();
    const drawing = svg.getBoundingClientRect();
    return {
      finite:
        animations.length > 0 &&
        animations.every((animation) => {
          const timing = animation.effect!.getComputedTiming();
          return timing.iterations === 1 && Number(timing.endTime) <= 4_150;
        }),
      visible: Array.from(hero.querySelectorAll(".arrive")).every(
        (element) => getComputedStyle(element).opacity === "1",
      ),
      tracesComplete: Array.from(hero.querySelectorAll(".trace")).every(
        (element) => getComputedStyle(element).strokeDashoffset === "0px",
      ),
      completeOpacity: getComputedStyle(hero.querySelector(".complete")!).opacity,
      sourceOpacity: getComputedStyle(hero.querySelector(".source-one")!).opacity,
      contentFits:
        content.x >= 0 &&
        content.y >= 0 &&
        content.x + content.width <= svg.viewBox.baseVal.width &&
        content.y + content.height <= svg.viewBox.baseVal.height,
      drawingFits:
        drawing.left >= bounds.left &&
        drawing.right <= bounds.right &&
        drawing.top >= bounds.top &&
        drawing.bottom <= bounds.bottom,
    };
  }, time);
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

  it.each([
    ["platformclaw", "light", "platformclaw-light", "rgb(250, 249, 245)"],
    ["platformclaw", "dark", "platformclaw", "rgb(24, 23, 21)"],
    ["claw", "light", "light", "rgb(250, 249, 247)"],
    ["claw", "dark", "dark", "rgb(14, 16, 21)"],
    ["knot", "light", "openknot-light", "rgb(249, 249, 251)"],
    ["knot", "dark", "openknot", "rgb(8, 8, 8)"],
    ["dash", "light", "dash-light", "rgb(247, 242, 236)"],
    ["dash", "dark", "dash", "rgb(26, 18, 16)"],
  ] as const)(
    "restores saved %s/%s before first paint when the OS disagrees",
    async (theme, themeMode, resolved, background) => {
      const { context, page } = await openLogin(
        themeMode === "light" ? "dark" : "light",
        { width: 1280, height: 900 },
        undefined,
        { theme, themeMode },
      );
      try {
        expect(await page.locator("html").getAttribute("data-theme")).toBe(resolved);
        expect(await page.locator("html").getAttribute("data-theme-mode")).toBe(themeMode);
        await expectThemedFirstPaint(page, resolved);
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
          background,
        );
        expect(
          await page
            .locator("[data-login-hero] .hero")
            .evaluate((hero) => getComputedStyle(hero).backgroundColor),
        ).toBe(
          await page
            .locator(".login-card")
            .evaluate((card) => getComputedStyle(card).backgroundColor),
        );
      } finally {
        await context.close();
      }
    },
  );

  it.each(["light", "dark"] as const)("restores saved custom/%s tokens", async (themeMode) => {
    const customTheme = createImportedCustomThemeFixture();
    customTheme.light = {
      ...customTheme.light,
      bg: "#f0f8ff",
      card: "#ffffff",
      "text-strong": "#102030",
    };
    customTheme.dark = {
      ...customTheme.dark,
      bg: "#102030",
      card: "#203040",
      "text-strong": "#f0f8ff",
    };
    const { context, page } = await openLogin(
      themeMode === "light" ? "dark" : "light",
      { width: 1280, height: 900 },
      undefined,
      { theme: "custom", themeMode, customTheme },
    );
    try {
      const resolved = themeMode === "light" ? "custom-light" : "custom";
      expect(await page.locator("html").getAttribute("data-theme")).toBe(resolved);
      await expectThemedFirstPaint(page, resolved);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        themeMode === "light" ? "rgb(240, 248, 255)" : "rgb(16, 32, 48)",
      );
      expect(
        await page
          .locator("[data-login-hero] .hero")
          .evaluate((hero) => getComputedStyle(hero).backgroundColor),
      ).toBe(themeMode === "light" ? "rgb(255, 255, 255)" : "rgb(32, 48, 64)");
    } finally {
      await context.close();
    }
  });

  it("tracks system mode and a real settings update from another tab", async () => {
    const { context, page } = await openLogin("light", { width: 1280, height: 900 }, undefined, {
      theme: "knot",
      themeMode: "system",
    });
    try {
      expect(await page.locator("html").getAttribute("data-theme")).toBe("openknot-light");
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("openknot");
      const writer = await context.newPage();
      await writer.route("**/appearance-fixture.html", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Appearance fixture</title>",
        }),
      );
      await writer.goto(`${server.baseUrl}appearance-fixture.html`);
      await writer.evaluate(
        (storage) =>
          localStorage.setItem(
            storage.settingsKey,
            JSON.stringify({
              gatewayUrl: storage.gatewayUrl,
              theme: "dash",
              themeMode: "light",
            }),
          ),
        appearanceStorage(),
      );
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dash-light");
      await page.emulateMedia({ colorScheme: "light" });
      await page.emulateMedia({ colorScheme: "dark" });
      expect(await page.locator("html").getAttribute("data-theme")).toBe("dash-light");
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        "rgb(247, 242, 236)",
      );
    } finally {
      await context.close();
    }
  });

  it("shows the complete static illustration when reduced motion is requested", async () => {
    const { context, page } = await openLogin("dark", { width: 1280, height: 900 }, undefined, {
      reducedMotion: "reduce",
    });
    try {
      const hero = page.locator("[data-login-hero] .hero");
      expect(
        await hero.evaluate((element) => element.getAnimations({ subtree: true }).length),
      ).toBe(0);
      const frame = await heroFrame(page, 0);
      expect(frame.visible).toBe(true);
      expect(frame.tracesComplete).toBe(true);
      expect(frame.contentFits).toBe(true);
      expect(frame.drawingFits).toBe(true);
      await screenshot(page, "desktop-dark-reduced-motion.png");
    } finally {
      await context.close();
    }
  });

  it("moves on the pixel grid, blinks, and masks its eyes for password entry", async () => {
    const { context, page } = await openLogin("light", { width: 1280, height: 900 });
    try {
      const mascot = page.locator("[data-login-mascot]");
      const runner = mascot.locator(".login-mascot__runner");
      const bodyPosition = () =>
        mascot.evaluate((element) =>
          Number.parseInt((element as HTMLElement).style.getPropertyValue("--mascot-x"), 10),
        );
      const renderedPosition = () =>
        runner.evaluate(
          (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41,
        );
      await page.mouse.move(120, 180);
      await expect.poll(bodyPosition).toBeLessThan(0);
      const left = await bodyPosition();
      expect(Math.abs(left % 2)).toBe(0);
      await expect.poll(renderedPosition).toBe(left);
      await screenshot(page, "mascot-pointer-left.png");
      await page.mouse.move(1160, 180);
      await expect.poll(bodyPosition).toBeGreaterThan(0);
      const right = await bodyPosition();
      expect(right % 2).toBe(0);
      await expect.poll(renderedPosition).toBe(right);
      await screenshot(page, "mascot-pointer-right.png");
      await page.waitForFunction(
        () => document.querySelector("[data-login-mascot]")!.classList.contains("is-blinking"),
        undefined,
        { timeout: 6_000 },
      );
      await page.waitForFunction(
        () => !document.querySelector("[data-login-mascot]")!.classList.contains("is-blinking"),
      );
      await page.locator('input[name="identifier"]').fill("person.one");
      expect(await mascot.getAttribute("data-login-mascot-mode")).toBe("account");
      const eyes = mascot.locator("#eyes");
      await expect
        .poll(() =>
          eyes.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).d),
        )
        .toBe(1);
      const openEyes = (await eyes.boundingBox())!.height;
      await page.locator('input[name="password"]').focus();
      expect(await mascot.getAttribute("data-login-mascot-mode")).toBe("password");
      await expect.poll(async () => (await eyes.boundingBox())!.height).toBe(openEyes / 4);
      await screenshot(page, "mascot-password.png");
    } finally {
      await context.close();
    }
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
          const mascotViewport = mascot.closest("[data-login-mascot]")!.getBoundingClientRect();
          const cardBox = card.getBoundingClientRect();
          return {
            background: getComputedStyle(document.body).backgroundColor,
            cardRight: cardBox.right,
            mascotHeight: mascotBox.height,
            mascotWidth: mascotBox.width,
            mascotCenterOffset:
              mascotBox.y + mascotBox.height / 2 - (mascotViewport.y + mascotViewport.height / 2),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        expect(layout.background).toBe(mode === "light" ? "rgb(250, 249, 245)" : "rgb(24, 23, 21)");
        expect(layout.mascotHeight).toBe(132);
        expect(layout.mascotWidth).toBe(132);
        expect(layout.mascotCenterOffset).toBe(0);
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
        await expect
          .poll(
            () =>
              hero.evaluate((element) =>
                element
                  .getAnimations({ subtree: true })
                  .every((animation) => animation.playState === "finished"),
              ),
            { timeout: 6_000 },
          )
          .toBe(true);
        for (const time of [0, 800, 1_800, 3_200, 4_300]) {
          const frame = await heroFrame(page, time);
          expect(frame.finite).toBe(true);
          expect(frame.contentFits).toBe(true);
          expect(frame.drawingFits).toBe(true);
          if (time === 0) {
            expect(frame.sourceOpacity).toBe("0");
            expect(frame.completeOpacity).toBe("0");
          }
          if (time === 4_300) {
            expect(frame.visible).toBe(true);
            expect(frame.tracesComplete).toBe(true);
          }
          await screenshot(page, `desktop-${mode}-${time}ms.png`);
        }
      } finally {
        await context.close();
      }
    },
  );

  it.each([
    { name: "desktop-light", mode: "light", width: 1920, height: 1080 },
    { name: "desktop-dark", mode: "dark", width: 1440, height: 900 },
    { name: "mobile", mode: "light", width: 390, height: 844 },
    { name: "mobile-dark", mode: "dark", width: 320, height: 568 },
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
      await expect
        .poll(() =>
          page
            .locator("[data-login-mascot]")
            .evaluate((element) =>
              Number.parseInt((element as HTMLElement).style.getPropertyValue("--mascot-x"), 10),
            ),
        )
        .toBeGreaterThan(0);
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

  it.each([320, 390, 900, 961, 1280, 1440])(
    "keeps the login within a %spx viewport",
    async (width) => {
      const { context, page } = await openLogin("light", { width, height: 900 });
      try {
        expect(await page.locator("[data-login-hero]").isVisible()).toBe(width > 960);
        expect(await page.locator(".login-card").isVisible()).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        const card = await page.locator(".login-card").boundingBox();
        expect(card!.x).toBeGreaterThanOrEqual(0);
        expect(card!.x + card!.width).toBeLessThanOrEqual(width);
        if (width > 960) {
          const frame = await heroFrame(page, 4_300);
          expect(frame.contentFits).toBe(true);
          expect(frame.drawingFits).toBe(true);
        }
        await screenshot(page, `responsive-${width}.png`);
      } finally {
        await context.close();
      }
    },
  );

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
