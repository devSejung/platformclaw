import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BASEBALL_RPC,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import { BASEBALL_TEAMS } from "../platformclaw/easter-egg-settings.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  installMockGateway,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  baseballSession,
  installBaseballDocument,
  setThemeMode,
} from "./platformclaw-baseball.e2e-helpers.ts";

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
  await page.locator('[data-game-choice="baseball"]').click();
  await page.locator(".platformclaw-easter-egg__shop-trigger").click();
  await page.getByRole("dialog", { name: "배트 강화·설정" }).waitFor();
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
    let teamProgress: BaseballProgress = { ...progress, gold: 100000 };
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "synthetic_agent",
      sessionKey: "agent:synthetic_agent:main",
      featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
      methodResponses: {
        [BASEBALL_RPC.beginAtBat]: {
          id: "settings-at-bat",
          pitchSample: 0.25,
          batId: progress.equippedBatId,
          issuedAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
        [BASEBALL_RPC.progress]: teamProgress,
        [BASEBALL_RPC.leaderboard]: {
          distance: [{ displayName: "synthetic-a", value: 147, isCurrentUser: true }],
          homeRunStreak: [],
        },
        [BASEBALL_RPC.plateAppearance]: { awardedGold: 0, progress },
      },
    });
    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await openSettings(page);
    const dialog = page.getByRole("dialog", { name: "배트 강화·설정" });
    const team = dialog.locator("#baseball-team");
    const opacity = dialog.getByRole("slider");
    expect(await team.locator("option").count()).toBe(11);
    expect(await dialog.getByText("다음 누적 보너스까지 1홈런", { exact: true }).isVisible()).toBe(
      true,
    );
    const player = page.locator(".platformclaw-easter-egg__player");
    for (const mode of ["dark", "light"] as const) {
      await setThemeMode(page, mode);
      for (const club of BASEBALL_TEAMS.slice(1)) {
        const chargedGold = teamProgress.teamId ? 2000 : 0;
        teamProgress = Object.assign({}, teamProgress, {
          teamId: club.id,
          gold: teamProgress.gold - chargedGold,
          revision: teamProgress.revision + 1,
        });
        await gateway.setMethodResponse(BASEBALL_RPC.selectTeam, {
          requestId: `synthetic-${mode}-${club.id}`,
          teamId: club.id,
          changed: true,
          chargedGold,
          progress: teamProgress,
        });
        await gateway.setMethodResponse(BASEBALL_RPC.progress, teamProgress);
        await team.selectOption(club.id);
        await expect
          .poll(() => player.locator(".platformclaw-easter-egg__cap-mark").textContent())
          .toBe(club.capMark);
        const cap = player.locator(".platformclaw-easter-egg__cap-crown");
        const paint = await cap.evaluate((element) => ({
          namespace: element.namespaceURI,
          fill: getComputedStyle(element).fill,
          width: element.getBoundingClientRect().width,
        }));
        expect(paint.namespace).toBe("http://www.w3.org/2000/svg");
        expect(paint.fill).toBe(
          club.capColor.replace(
            /^#(..)(..)(..)$/,
            (_, r, g, b) =>
              `rgb(${Number.parseInt(r, 16)}, ${Number.parseInt(g, 16)}, ${Number.parseInt(b, 16)})`,
          ),
        );
        expect(paint.width).toBeGreaterThan(10);
        await dialog.getByRole("button", { name: "닫기" }).click();
        await capture(page, `team-${club.id}-${mode}.png`);
        await page.locator(".platformclaw-easter-egg__shop-trigger").click();
      }
    }
    expect(await team.inputValue()).toBe("hanwha");
    await expect.poll(() => player.textContent()).toContain("한화 이글스");
    expect(
      await player
        .locator(".platformclaw-easter-egg__figure-torso")
        .evaluate((element) => getComputedStyle(element).stroke),
    ).toBe("rgb(252, 78, 0)");
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
    await gateway.setMethodResponse(BASEBALL_RPC.progress, progress);
    await page.reload();
    await openSettings(page);
    expect(await team.inputValue()).toBe("");
    expect(await opacity.inputValue()).toBe("100");
    accountId = "synthetic-a";
    await gateway.setMethodResponse(BASEBALL_RPC.progress, teamProgress);
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
    // A pre-server local team cache must not grant an unselected account a team.
    await gateway.setMethodResponse(BASEBALL_RPC.progress, progress);
    await page.reload();
    await openSettings(page);
    expect(await team.inputValue()).toBe("");
    expect(await page.locator('[role="application"]').getAttribute("data-team-id")).toBe("neutral");
    expect(await opacity.inputValue()).toBe("100");
    await capture(page, "08-server-no-team-clears-local-cache.png");
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
        [BASEBALL_RPC.beginAtBat]: {
          id: "bonus-at-bat",
          pitchSample: 0.25,
          batId: progress.equippedBatId,
          issuedAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
        [BASEBALL_RPC.plateAppearance]: {
          __mockError: { code: "UNAVAILABLE", message: "Synthetic lost response" },
        },
      },
    });
    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await openSettings(page);
    const dialog = page.getByRole("dialog", { name: "배트 강화·설정" });
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
    await gateway.deferNext(BASEBALL_RPC.progress);
    await page.getByRole("button", { name: "재시도", exact: true }).click();
    await page.clock.runFor(20);
    await bonus.waitFor();
    const requests = await gateway.getRequests(BASEBALL_RPC.plateAppearance);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.params).toEqual(requests[0]!.params);
    expect(await bonus.textContent()).toContain("누적 5홈런 보너스 +5G");
    expect(await bonus.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
    expect(await bonus.locator("..").evaluate((element) => getComputedStyle(element).opacity)).toBe(
      "0.3",
    );
    await capture(page, "05-confirmed-bonus-30.png");
    const round = Number(await game.getAttribute("data-round"));
    const atBatRequests = (await gateway.getRequests(BASEBALL_RPC.beginAtBat)).length;
    await gateway.deferNext(BASEBALL_RPC.beginAtBat);
    await page.clock.runFor(650);
    expect(await bonus.count()).toBe(1);
    expect(Number(await game.getAttribute("data-round"))).toBe(round + 1);
    expect(await gateway.getRequests(BASEBALL_RPC.beginAtBat)).toHaveLength(atBatRequests + 1);
    expect(await game.getAttribute("data-pitch-state")).toBe("ready");
    await gateway.resolveDeferred(BASEBALL_RPC.progress);
    await expect.poll(() => game.textContent()).toContain("투구 준비 중");
    expect(await game.textContent()).toContain("골드 1244");
    expect(
      await bonus
        .locator("i")
        .first()
        .evaluate((element) => getComputedStyle(element).animationDuration),
    ).toBe("0.9s");
    await capture(page, "07-bonus-next-round-ready.png");
    await page.clock.runFor(250);
    expect(await bonus.count()).toBe(0);
    expect(await game.textContent()).toContain("직전 보상 +10G");
    await gateway.resolveDeferred(BASEBALL_RPC.beginAtBat);
    await host.evaluate((element, params) => {
      void (
        element as HTMLElement & { runMutation: (mutation: unknown) => Promise<void> }
      ).runMutation({
        method: "platformclaw.baseball.plateAppearance",
        params,
        label: "synthetic replay",
      });
    }, requests[0]!.params);
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
