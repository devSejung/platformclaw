import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BASEBALL_RPC,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  installMockGateway,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { baseballSession, installBaseballDocument } from "./platformclaw-baseball.e2e-helpers.ts";

const artifactDir = path.join(process.cwd(), ".artifacts/control-ui-e2e/baseball-settings");
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const progress: BaseballProgress = {
  gold: 1234,
  ownedBatIds: ["wood", "titanium", "diamond"],
  equippedBatId: "diamond",
  totalHomers: 9,
  bestDistanceM: 147,
  currentHomeRunStreak: 0,
  bestHomeRunStreak: 4,
  revision: 42,
};
let browser: Browser;
let server: ControlUiE2eServer;
let context: BrowserContext;

async function openSettings(page: Page): Promise<void> {
  const brand = page.locator("openclaw-app-topbar .topbar-brand");
  await brand.waitFor({ state: "attached" });
  await brand.evaluate(async (element) => {
    for (let index = 0; index < 7; index += 1) {
      (element as HTMLElement).click();
      await new Promise((resolve) => {
        window.setTimeout(resolve, 25);
      });
    }
  });
  await page.locator(".platformclaw-easter-egg__shop-trigger").click();
  await page.getByRole("dialog", { name: "배트 상점" }).waitFor();
}

async function capture(page: Page, name: string): Promise<void> {
  if (captureProof) {
    await page.screenshot({ path: path.join(artifactDir, name), fullPage: true });
  }
}

describeE2e("baseball settings in a real browser with synthetic account data", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
    if (captureProof) {
      await mkdir(artifactDir, { recursive: true });
    }
  });
  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await server?.close();
  });
  afterEach(async () => {
    await context?.close();
  });

  it("saves teams and opacity, isolates a second account, and recovers at mobile width", async () => {
    context = await browser.newContext({
      locale: "ko-KR",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
      recordVideo: captureProof
        ? { dir: artifactDir, size: { width: 1280, height: 800 } }
        : undefined,
    });
    const page = await context.newPage();
    let accountId = "synthetic-a";
    await installBaseballDocument(page, server.baseUrl);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: baseballSession(accountId, "synthetic_agent") }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "synthetic_agent",
      sessionKey: "agent:synthetic_agent:main",
      featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
      methodResponses: {
        [BASEBALL_RPC.progress]: progress,
        [BASEBALL_RPC.leaderboard]: {
          distance: [{ displayName: "synthetic-a", value: 147, isCurrentUser: true }],
          homeRunStreak: [],
        },
        [BASEBALL_RPC.plateAppearance]: { awardedGold: 0, progress },
      },
    });
    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await openSettings(page);
    const dialog = page.getByRole("dialog", { name: "배트 상점" });
    const team = dialog.getByLabel("응원 팀 · 무료");
    const opacity = dialog.getByRole("slider");
    expect(await team.locator("option").count()).toBe(11);
    expect(await dialog.getByText("다음 누적 보너스까지 1홈런", { exact: true }).isVisible()).toBe(
      true,
    );
    await team.selectOption("hanwha");
    const player = page.locator(".platformclaw-easter-egg__player");
    await expect.poll(() => player.textContent()).toContain("한화 이글스");
    expect(
      await player.locator("circle").evaluate((element) => getComputedStyle(element).fill),
    ).toBe("rgb(232, 121, 50)");
    await opacity.focus();
    await opacity.press("Home");
    await expect.poll(() => opacity.inputValue()).toBe("30");
    expect(await dialog.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    await capture(page, "01-desktop-settings-30.png");
    await dialog.getByRole("button", { name: "닫기" }).click();
    const scene = page.locator(".platformclaw-easter-egg__scene");
    await expect
      .poll(() => scene.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("0.3");
    const trigger = page.locator(".platformclaw-easter-egg__shop-trigger");
    expect(await trigger.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    await capture(page, "02-desktop-game-30.png");
    await page.reload();
    await openSettings(page);
    expect(await team.inputValue()).toBe("hanwha");
    expect(await opacity.inputValue()).toBe("30");
    accountId = "synthetic-b";
    await page.reload();
    await openSettings(page);
    expect(await team.inputValue()).toBe("neutral");
    expect(await opacity.inputValue()).toBe("100");
    accountId = "synthetic-a";
    await page.reload();
    await openSettings(page);
    expect(await team.inputValue()).toBe("hanwha");
    expect(await opacity.inputValue()).toBe("30");
    await page.setViewportSize({ width: 375, height: 812 });
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(812);
    await capture(page, "03-mobile-settings-30.png");
    await dialog.getByRole("button", { name: "100%로 복구" }).click();
    expect(await team.inputValue()).toBe("hanwha");
    await expect.poll(() => opacity.inputValue()).toBe("100");
    expect(await gateway.getRequests(BASEBALL_RPC.purchaseBat)).toHaveLength(0);
    expect(await gateway.getRequests(BASEBALL_RPC.equipBat)).toHaveLength(0);
    await dialog.getByRole("button", { name: "닫기" }).click();
    await expect
      .poll(() => scene.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    await capture(page, "04-mobile-game-restored.png");
    const playerBounds = await player.boundingBox();
    expect(playerBounds!.y).toBeGreaterThanOrEqual(0);
    expect(playerBounds!.y + playerBounds!.height).toBeLessThanOrEqual(812);
    await page.reload();
    await openSettings(page);
    expect(await opacity.inputValue()).toBe("100");
  });

  it("celebrates only a confirmed bonus receipt, once after retry, without delaying the next pitch", async () => {
    context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await installBaseballDocument(page, server.baseUrl);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: baseballSession("synthetic-bonus", "synthetic_agent") }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "synthetic_agent",
      sessionKey: "agent:synthetic_agent:main",
      featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
      methodResponses: {
        [BASEBALL_RPC.progress]: progress,
        [BASEBALL_RPC.leaderboard]: { distance: [], homeRunStreak: [] },
        [BASEBALL_RPC.plateAppearance]: {
          __mockError: { code: "UNAVAILABLE", message: "Synthetic lost response" },
        },
      },
    });
    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await openSettings(page);
    const dialog = page.getByRole("dialog", { name: "배트 상점" });
    await dialog.getByRole("slider").focus();
    await dialog.getByRole("slider").press("Home");
    const frozen = new Date(await page.evaluate(() => Date.now() + 1000));
    await page.clock.install({ time: frozen });
    await page.clock.pauseAt(frozen);
    await dialog.getByRole("button", { name: "닫기" }).click();
    const host = page.locator("platformclaw-easter-egg");
    const game = page.locator('platformclaw-easter-egg [role="application"]');
    const bonus = page.locator(".platformclaw-easter-egg__bonus");
    // Exercise receipt transport independently; ball physics has its own browser scenario.
    await host.evaluate((element) => {
      (
        element as HTMLElement & { resolveAtBat: (outcome: string, distance: number) => void }
      ).resolveAtBat("home_run", 145);
    });
    await page.clock.runFor(20);
    await page.getByText("타석 저장 실패", { exact: true }).waitFor();
    expect(await bonus.count()).toBe(0);
    const receipt = {
      awardedGold: 10,
      homeRunBonusGold: 5,
      progress: { ...progress, gold: 1244, totalHomers: 10, currentHomeRunStreak: 1, revision: 43 },
    };
    await gateway.setMethodResponse(BASEBALL_RPC.plateAppearance, receipt);
    await page.getByRole("button", { name: "재시도", exact: true }).click();
    await page.clock.runFor(20);
    await bonus.waitFor();
    const requests = await gateway.getRequests(BASEBALL_RPC.plateAppearance);
    expect(requests).toHaveLength(2);
    expect(requests[1].params).toEqual(requests[0].params);
    expect(await bonus.textContent()).toContain("누적 5홈런 보너스 +5G");
    expect(await bonus.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
    expect(await bonus.locator("..").evaluate((element) => getComputedStyle(element).opacity)).toBe(
      "0.3",
    );
    await capture(page, "05-confirmed-bonus-30.png");
    await page.clock.runFor(550);
    expect(await bonus.count()).toBe(0);
    await page.clock.runFor(100);
    expect(await game.getAttribute("data-pitch-state")).toBe("ready");
    expect(await game.textContent()).toContain("직전 보상 +10G");
    await host.evaluate((element, params) => {
      void (
        element as HTMLElement & { runMutation: (mutation: unknown) => Promise<void> }
      ).runMutation({
        method: "platformclaw.baseball.plateAppearance",
        params,
        label: "synthetic replay",
      });
    }, requests[0].params);
    await page.clock.runFor(20);
    expect(await bonus.count()).toBe(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await host.evaluate((element) => {
      (
        element as HTMLElement & { resolveAtBat: (outcome: string, distance: number) => void }
      ).resolveAtBat("home_run", 145);
    });
    await page.clock.runFor(20);
    await bonus.waitFor();
    expect(
      await bonus
        .locator(".platformclaw-easter-egg__sparks")
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("none");
    await capture(page, "06-reduced-motion-bonus.png");
    await host.evaluate((element) => {
      (element as HTMLElement & { preferenceScope: string }).preferenceScope =
        "synthetic-next-account";
    });
    await expect.poll(() => game.count()).toBe(0);
    await page.clock.runFor(1000);
    expect(await bonus.count()).toBe(0);
  });
});
