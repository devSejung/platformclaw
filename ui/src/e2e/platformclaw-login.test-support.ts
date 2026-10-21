import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { describe, expect } from "vitest";
import {
  currentGatewaySelectionKeyForPage,
  settingsKeyForGateway,
} from "../app/settings-storage.ts";
import type { ThemeMode, ThemeName } from "../app/theme.ts";
import { LOCALE_STORAGE_KEY } from "../i18n/lib/locale-preferences.ts";
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

type LoginAppearance = {
  theme?: ThemeName;
  themeMode?: ThemeMode;
  customTheme?: ReturnType<typeof createImportedCustomThemeFixture>;
  reducedMotion?: "reduce" | "no-preference";
  storedLocale?: "en" | "ko";
  browserLocale?: string;
  pauseIntro?: boolean;
};

export function createPlatformClawLoginE2eFixture() {
  let browser: Browser;
  let server: ControlUiE2eServer;
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
      locale: appearance.browserLocale ?? "ko-KR",
      recordVideo: captureVideo
        ? { dir: path.join(artifactDir, "video"), size: viewport }
        : undefined,
      serviceWorkers: "block",
      viewport,
    });
    // Reproduce the original order: the app persists its selected Gateway's
    // appearance before the separate login document bootstraps.
    await context.addInitScript(
      ({ storage, preferences, localeKey, locale }) => {
        if (locale) {
          localStorage.setItem(localeKey, locale);
        }
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
            document.documentElement.dataset.firstPaintTheme =
              document.documentElement.dataset.theme;
            document.documentElement.dataset.firstPaintLocale = document.documentElement.lang;
          }
        }).observe({ type: "paint", buffered: true });
        new MutationObserver((records, observer) => {
          if (records.some((record) => record.target === document.documentElement)) {
            document.documentElement.dataset.localeAppliedAt = String(performance.now());
            observer.disconnect();
          }
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ["lang"] });
      },
      {
        storage: scopedStorage,
        localeKey: LOCALE_STORAGE_KEY,
        locale: appearance.storedLocale,
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
    if (appearance.pauseIntro) {
      await page.locator("[data-login-hero] .hero").evaluate((hero) => {
        for (const animation of hero.getAnimations({ subtree: true })) {
          animation.pause();
          animation.currentTime = 0;
        }
      });
    }
    const identifier = page.locator('input[name="identifier"]');
    await identifier.waitFor();
    await expect.poll(() => identifier.isEnabled()).toBe(true);
    const notice = page.locator(".login-security-notice");
    expect(await notice.isVisible()).toBe(true);
    expect(await notice.locator("p").count()).toBe(1);
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

  return {
    describe: describeE2e,
    openLogin,
    screenshot,
    appearanceStorage,
    get baseUrl() {
      return server.baseUrl;
    },
    async start() {
      if (!chromiumAvailable) {
        throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
      }
      server = await startControlUiE2eServer();
      browser = await chromium.launch({ executablePath });
    },
    async close() {
      await browser?.close();
      await server?.close();
    },
  };
}

export async function expectThemedFirstPaint(page: Page, theme: string): Promise<void> {
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

export async function heroFrame(page: Page, time: number) {
  return page.locator("[data-login-hero] .hero").evaluate((hero, currentTime) => {
    const animations = Array.from(hero.querySelectorAll(".arrive, .trace")).flatMap((element) =>
      element.getAnimations(),
    );
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
