import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BASEBALL_RPC,
  type BaseballLeaderboard,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import * as baseballProof from "./platformclaw-baseball.e2e-helpers.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "platformclaw-baseball",
);

let browser: Browser;
let server: ControlUiE2eServer;
const contexts = new Set<BrowserContext>();

const progress = (overrides: Partial<BaseballProgress> = {}): BaseballProgress => ({
  gold: 0,
  ownedBatIds: ["wood"],
  equippedBatId: "wood",
  totalHomers: 0,
  bestDistanceM: 0,
  currentHomeRunStreak: 0,
  bestHomeRunStreak: 0,
  revision: 0,
  ...overrides,
});

const leaderboard = (overrides: Partial<BaseballLeaderboard> = {}): BaseballLeaderboard => ({
  distance: [],
  homeRunStreak: [],
  ...overrides,
});

function session(accountId: string, agentId: string) {
  return {
    authenticated: true,
    user: {
      accountId,
      displayName: accountId,
      department: "Platform Lab",
      globalRole: "member",
    },
    agent: { agentId, state: "active" },
    session: {
      idleExpiresAt: Date.now() + 60_000,
      absoluteExpiresAt: Date.now() + 120_000,
    },
  };
}

async function installPlatformClawDocument(page: Page): Promise<void> {
  const response = await page.request.get(server.baseUrl);
  const source = await response.text();
  await page.route("**/platformclaw/app/**", (route) =>
    route.fulfill({
      body: source.replace(
        "</head>",
        `<meta name="platformclaw-web-descriptor" content='${JSON.stringify({ ...PLATFORMCLAW_WEB_DESCRIPTOR, vocEnabled: true })}'></head>`,
      ),
      headers: response.headers(),
      status: response.status(),
    }),
  );
}

async function openGame(page: Page): Promise<void> {
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
  await page.locator('platformclaw-easter-egg [role="application"]').waitFor();
}

async function capture(page: Page, fileName: string): Promise<void> {
  if (!captureProof) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(artifactDir, fileName),
  });
}

async function captureMotionPhase(page: Page, state: string, fileName: string): Promise<string> {
  const actor = page.locator(".platformclaw-easter-egg__target");
  await actor.evaluate((element, phase) => {
    element.setAttribute(
      "class",
      `platformclaw-easter-egg__target platformclaw-easter-egg__target--${phase}`,
    );
  }, state);
  const handle = await actor.elementHandle();
  if (!handle) {
    throw new Error(`missing pitcher state ${state}`);
  }
  await page.waitForTimeout(70);
  const pose = await handle.evaluate((element) => {
    const transforms: string[] = [];
    for (const part of element.querySelectorAll<HTMLElement>("[class*='__figure-']")) {
      const transform = getComputedStyle(part).transform;
      transforms.push(transform);
      part.style.transform = transform;
      part.style.animation = "none";
    }
    return transforms.join("|");
  });
  expect(pose).toMatch(/matrix/u);
  if (captureProof) {
    await mkdir(artifactDir, { recursive: true });
    await page.screenshot({
      animations: "allow",
      fullPage: true,
      path: path.join(artifactDir, fileName),
    });
    const bounds = await handle.boundingBox();
    if (bounds) {
      const padding = 48;
      await page.screenshot({
        animations: "allow",
        clip: {
          x: Math.max(0, bounds.x - padding),
          y: Math.max(0, bounds.y - padding),
          width: Math.min(page.viewportSize()?.width ?? 0, bounds.width + padding * 2),
          height: Math.min(page.viewportSize()?.height ?? 0, bounds.height + padding * 2),
        },
        path: path.join(artifactDir, fileName.replace(".png", "-detail.png")),
      });
    }
  }
  await handle.evaluate((element) => {
    for (const part of element.querySelectorAll<HTMLElement>("[class*='__figure-']")) {
      part.style.removeProperty("animation");
      part.style.removeProperty("transform");
    }
  });
  return pose;
}

async function newAccountPage(
  accountId: string,
  agentId: string,
  methodResponses: Record<string, unknown>,
  viewport = { height: 900, width: 760 },
) {
  if (captureProof) {
    await mkdir(artifactDir, { recursive: true });
  }
  const context = await browser.newContext({
    locale: "ko-KR",
    recordVideo:
      captureProof && viewport.width === 1280 ? { dir: artifactDir, size: viewport } : undefined,
    serviceWorkers: "block",
    viewport,
  });
  contexts.add(context);
  const page = await context.newPage();
  await installPlatformClawDocument(page);
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({ json: session(accountId, agentId), status: 200 }),
  );
  const gateway = await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: agentId,
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    methodResponses,
    sessionKey: `agent:${agentId}:main`,
  });
  await page.goto(`${server.baseUrl}platformclaw/app/chat`);
  return { gateway, page };
}

describeE2e("PlatformClaw baseball mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });

  afterEach(async () => {
    await Promise.all([...contexts].map((context) => context.close().catch(() => {})));
    contexts.clear();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("buys and equips a bat, restores progress, and isolates another account", async () => {
    const viewport = { height: 800, width: 1280 };
    const initialA = progress({ gold: 50, totalHomers: 3, bestDistanceM: 138, revision: 1 });
    const purchasedA = progress({
      gold: 0,
      ownedBatIds: ["wood", "silver"],
      totalHomers: 3,
      bestDistanceM: 138,
      revision: 2,
    });
    const equippedA = progress({
      ...purchasedA,
      equippedBatId: "silver",
      revision: 3,
    });
    const accountA = await newAccountPage(
      "person.a",
      "person_a",
      {
        [BASEBALL_RPC.progress]: { sequence: [initialA, equippedA] },
        [BASEBALL_RPC.leaderboard]: leaderboard({
          distance: [{ displayName: "person.a", value: 138, isCurrentUser: true }],
          homeRunStreak: [{ displayName: "person.a", value: 2, isCurrentUser: true }],
        }),
        [BASEBALL_RPC.purchaseBat]: {
          batId: "silver",
          price: 50,
          purchased: true,
          progress: purchasedA,
        },
        [BASEBALL_RPC.equipBat]: { batId: "silver", changed: true, progress: equippedA },
      },
      viewport,
    );

    await openGame(accountA.page);
    expect((await accountA.gateway.waitForRequest(BASEBALL_RPC.progress)).params).toEqual({});
    expect((await accountA.gateway.waitForRequest(BASEBALL_RPC.leaderboard)).params).toEqual({});
    const game = accountA.page.locator('platformclaw-easter-egg [role="application"]');
    await expect.poll(() => game.getByText("골드 50", { exact: true }).isVisible()).toBe(true);
    const distanceBoard = game.locator(".platformclaw-easter-egg__leaderboards section").filter({
      hasText: "비거리 TOP 5",
    });
    const streakBoard = game.locator(".platformclaw-easter-egg__leaderboards section").filter({
      hasText: "연속 홈런 TOP 5",
    });
    await expect.poll(() => distanceBoard.isVisible()).toBe(true);
    await expect
      .poll(() => distanceBoard.getByText("1. person.a (나)", { exact: true }).isVisible())
      .toBe(true);
    await expect.poll(() => streakBoard.isVisible()).toBe(true);
    const initialShop = game.getByRole("button", { name: "나무 배트 · 상점" });
    const initialShopBounds = await initialShop.boundingBox();
    expect(initialShopBounds).not.toBeNull();
    expect(initialShopBounds!.x).toBeGreaterThanOrEqual(0);
    expect(initialShopBounds!.x + initialShopBounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(initialShopBounds!.y).toBeGreaterThanOrEqual(0);
    expect(initialShopBounds!.y + initialShopBounds!.height).toBeLessThanOrEqual(viewport.height);
    await initialShop.click();

    const dialog = game.getByRole("dialog", { name: "배트 상점" });
    await dialog.waitFor();
    await game.locator(".platformclaw-easter-egg__shop-scrim").click({ position: { x: 4, y: 4 } });
    expect(await dialog.isVisible()).toBe(true);

    await dialog.getByRole("button", { name: /실버.*50골드 구매/u }).click();
    const purchase = await accountA.gateway.waitForRequest(BASEBALL_RPC.purchaseBat);
    expect(purchase.params).toMatchObject({ batId: "silver" });
    expect((purchase.params as { requestId?: unknown }).requestId).toEqual(expect.any(String));
    await expect
      .poll(() => dialog.getByRole("button", { name: /실버.*장착$/u }).isVisible())
      .toBe(true);

    await dialog.getByRole("button", { name: /실버.*장착$/u }).click();
    const equip = await accountA.gateway.waitForRequest(BASEBALL_RPC.equipBat);
    expect(equip.params).toMatchObject({ batId: "silver" });
    await expect.poll(() => game.getByText("골드 0", { exact: true }).isVisible()).toBe(true);
    await expect
      .poll(() => game.getByRole("button", { name: "실버 배트 · 상점" }).isVisible())
      .toBe(true);
    await capture(accountA.page, "01-equipped-silver.png");

    await dialog.getByRole("button", { name: "닫기" }).click();
    await game.press("Escape");
    await game.waitFor({ state: "detached" });
    await accountA.page.evaluate(() => window.dispatchEvent(new Event("platformclaw:easter-egg")));
    await expect
      .poll(async () => (await accountA.gateway.getRequests(BASEBALL_RPC.progress)).length)
      .toBe(2);
    await expect
      .poll(async () => (await accountA.gateway.getRequests(BASEBALL_RPC.leaderboard)).length)
      .toBe(2);
    const reopened = accountA.page.locator('platformclaw-easter-egg [role="application"]');
    await expect
      .poll(() => reopened.getByRole("button", { name: "실버 배트 · 상점" }).isVisible())
      .toBe(true);
    await expect
      .poll(() => reopened.getByText("최고 138m", { exact: true }).isVisible())
      .toBe(true);
    const reopenedDistanceBoard = reopened
      .locator(".platformclaw-easter-egg__leaderboards section")
      .filter({ hasText: "비거리 TOP 5" });
    await expect
      .poll(() => reopenedDistanceBoard.getByText("1. person.a (나)", { exact: true }).isVisible())
      .toBe(true);
    await capture(accountA.page, "02-restored-account-a.png");

    const accountB = await newAccountPage(
      "person.b",
      "person_b",
      {
        [BASEBALL_RPC.progress]: progress(),
        [BASEBALL_RPC.leaderboard]: leaderboard(),
      },
      viewport,
    );
    await openGame(accountB.page);
    expect((await accountB.gateway.waitForRequest(BASEBALL_RPC.progress)).params).toEqual({});
    const gameB = accountB.page.locator('platformclaw-easter-egg [role="application"]');
    await expect
      .poll(() => gameB.getByRole("button", { name: "나무 배트 · 상점" }).isVisible())
      .toBe(true);
    await expect.poll(() => gameB.getByText("최고 0m", { exact: true }).isVisible()).toBe(true);
    expect(await gameB.getByText("최고 138m", { exact: true }).count()).toBe(0);
    await capture(accountB.page, "03-isolated-account-b.png");
  });

  it("anchors articulated players and the ranking board inside the desktop field", async () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      displayName: `아주 긴 세션 이름 ${index + 1} — platform laboratory`,
      value: 180 - index * 7,
      isCurrentUser: index === 2,
    }));

    const viewport = { height: 800, width: 1280 };
    const account = await newAccountPage(
      "visual-desktop",
      "visual_desktop",
      {
        [BASEBALL_RPC.progress]: progress({ bestDistanceM: 180 }),
        [BASEBALL_RPC.leaderboard]: leaderboard({
          distance: entries,
          homeRunStreak: entries.map((entry, index) => ({
            displayName: entry.displayName,
            isCurrentUser: entry.isCurrentUser,
            value: 9 - index,
          })),
        }),
        [BASEBALL_RPC.plateAppearance]: {
          awardedGold: 0,
          progress: progress({ bestDistanceM: 180 }),
        },
      },
      viewport,
    );
    await account.page.locator("platformclaw-easter-egg").evaluate((element) => {
      (element as HTMLElement & { random: () => number }).random = () => 0.5;
    });
    await openGame(account.page);
    const game = account.page.locator('platformclaw-easter-egg [role="application"]');
    const board = game.locator(".platformclaw-easter-egg__leaderboards");
    await board.waitFor();
    await expect.poll(() => game.getByText("145km/h", { exact: true }).isVisible()).toBe(true);
    const phaseBeforeShop = await game.getAttribute("data-pitch-state");
    const plateAppearancesBeforeShop = (
      await account.gateway.getRequests(BASEBALL_RPC.plateAppearance)
    ).length;
    await game.getByRole("button", { name: "나무 배트 · 상점" }).click();
    const shopDialog = game.getByRole("dialog", { name: "배트 상점" });
    await shopDialog.waitFor();
    await account.page.waitForTimeout(250);
    expect(await game.getAttribute("data-pitch-state")).toBe(phaseBeforeShop);
    expect((await account.gateway.getRequests(BASEBALL_RPC.plateAppearance)).length).toBe(
      plateAppearancesBeforeShop,
    );
    await shopDialog.getByRole("button", { name: "닫기" }).click();
    expect(await baseballProof.denseSessionOverlapCounts(account.page)).toEqual([0, 0, 0]);
    const poses = [
      await captureMotionPhase(account.page, "leg-lift", "visual-1280-leg-lift.png"),
      await captureMotionPhase(account.page, "throw", "visual-1280-throw.png"),
      await captureMotionPhase(account.page, "follow-through", "visual-1280-follow-through.png"),
    ];
    expect(new Set(poses).size).toBe(3);

    const geometry = await game.evaluate((root) => {
      const rect = (selector: string) => {
        const bounds = root.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        if (!bounds) {
          throw new Error(`missing ${selector}`);
        }
        return {
          bottom: bounds.bottom,
          height: bounds.height,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          width: bounds.width,
        };
      };
      return {
        arena: rect(".platformclaw-easter-egg__arena"),
        bat: rect(".platformclaw-easter-egg__bat"),
        board: rect(".platformclaw-easter-egg__leaderboards"),
        boardPaint: (() => {
          const style = getComputedStyle(
            root.querySelector<HTMLElement>(".platformclaw-easter-egg__leaderboards")!,
          );
          return {
            background: style.backgroundColor,
            borderWidth: style.borderTopWidth,
            color: style.color,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            opacity: style.opacity,
            padding: style.padding,
            shadow: style.boxShadow,
          };
        })(),
        fence: rect(".platformclaw-easter-egg__fence"),
        hud: rect(".platformclaw-easter-egg__hud"),
        composer: (() => {
          const bounds = document
            .querySelector<HTMLElement>(".agent-chat__composer-shell")
            ?.getBoundingClientRect();
          if (!bounds) {
            throw new Error("missing composer");
          }
          return {
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
          };
        })(),
        lastNavBottom: Math.max(
          0,
          ...Array.from(document.querySelectorAll<HTMLElement>(".sidebar .nav-item")).map(
            (element) => element.getBoundingClientRect().bottom,
          ),
        ),
        navRight: Number.parseFloat(getComputedStyle(root).getPropertyValue("--shell-nav-width")),
        overlayPointerEvents: getComputedStyle(root.closest("platformclaw-easter-egg")!)
          .pointerEvents,
        outfielder: rect(".platformclaw-easter-egg__outfielder"),
        pitcher: rect(".platformclaw-easter-egg__target"),
        player: rect(".platformclaw-easter-egg__player"),
        score: rect(".platformclaw-easter-egg__score"),
        scorePaint: (() => {
          const style = getComputedStyle(
            root.querySelector<HTMLElement>(".platformclaw-easter-egg__score")!,
          );
          return {
            color: style.color,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            opacity: style.opacity,
          };
        })(),
        scoreText: Array.from(
          root.querySelectorAll<HTMLElement>(".platformclaw-easter-egg__score > span"),
        ).map((element) => element.textContent),
        hudMetrics: Array.from(
          root.querySelectorAll<HTMLElement>(".platformclaw-easter-egg__hud > span"),
        ).map((element) => element.textContent),
        sidebarBody: (() => {
          const bounds = document
            .querySelector<HTMLElement>(".sidebar-shell__body")
            ?.getBoundingClientRect();
          if (!bounds) {
            throw new Error("missing sidebar body");
          }
          return {
            bottom: bounds.bottom,
            height: bounds.height,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width,
          };
        })(),
        shop: rect(".platformclaw-easter-egg__shop-trigger"),
        shopPointerEvents: getComputedStyle(
          root.querySelector<HTMLElement>(".platformclaw-easter-egg__shop-trigger")!,
        ).pointerEvents,
        rankingSections: Array.from(
          root.querySelectorAll<HTMLElement>(".platformclaw-easter-egg__leaderboards section"),
        ).map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
          };
        }),
        voc: (() => {
          const quickActions = document.querySelector<HTMLElement>("platformclaw-quick-actions");
          const bounds = quickActions?.shadowRoot
            ?.querySelector<HTMLElement>('button[aria-label="VOC"]')
            ?.getBoundingClientRect();
          if (!bounds) {
            throw new Error("missing VOC anchor");
          }
          return {
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
          };
        })(),
        labelPaint: (() => {
          const style = getComputedStyle(
            root.querySelector<HTMLElement>(".platformclaw-easter-egg__figure-label")!,
          );
          return {
            color: style.color,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            opacity: style.opacity,
          };
        })(),
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    const overlaps = (
      a: { bottom: number; left: number; right: number; top: number },
      b: { bottom: number; left: number; right: number; top: number },
    ) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

    expect(Math.abs(geometry.player.bottom - geometry.fence.bottom)).toBeLessThanOrEqual(2);
    expect(geometry.arena.left).toBe(0);
    expect(geometry.arena.width).toBe(geometry.viewportWidth);
    expect(Math.abs(geometry.pitcher.bottom - geometry.fence.bottom)).toBeLessThanOrEqual(2);
    expect(Math.abs(geometry.outfielder.bottom - geometry.fence.bottom)).toBeLessThanOrEqual(2);
    expect(overlaps(geometry.bat, geometry.player)).toBe(true);
    expect(overlaps(geometry.board, geometry.hud)).toBe(false);
    expect(overlaps(geometry.board, geometry.player)).toBe(false);
    expect(overlaps(geometry.board, geometry.pitcher)).toBe(false);
    expect(overlaps(geometry.shop, geometry.fence)).toBe(false);
    expect(overlaps(geometry.shop, geometry.outfielder)).toBe(false);
    expect(overlaps(geometry.shop, geometry.composer)).toBe(false);
    expect(geometry.rankingSections.every((section) => !overlaps(geometry.shop, section))).toBe(
      true,
    );
    const rankingGap =
      Math.min(...geometry.rankingSections.map((section) => section.top)) - geometry.shop.bottom;
    expect(rankingGap).toBeGreaterThanOrEqual(4);
    expect(rankingGap).toBeLessThanOrEqual(10);
    expect(Math.abs(geometry.shop.right - (geometry.board.right - 6))).toBeLessThanOrEqual(2);
    expect(geometry.shop.left).toBeGreaterThanOrEqual(geometry.board.left);
    expect(geometry.shop.right).toBeLessThanOrEqual(geometry.board.right);
    expect(geometry.shop.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.shopPointerEvents).toBe("auto");
    expect(overlaps(geometry.hud, geometry.player)).toBe(false);
    expect(overlaps(geometry.score, geometry.player)).toBe(false);
    expect(overlaps(geometry.score, geometry.pitcher)).toBe(false);
    expect(overlaps(geometry.score, geometry.voc)).toBe(false);
    expect(geometry.sidebarBody.bottom).toBeLessThanOrEqual(geometry.score.top);
    expect(geometry.sidebarBody.bottom).toBeLessThanOrEqual(geometry.player.top);
    expect(geometry.sidebarBody.bottom).toBeLessThanOrEqual(geometry.pitcher.top);
    expect(geometry.score.left).toBeGreaterThanOrEqual(0);
    expect(geometry.score.right).toBeLessThanOrEqual(geometry.navRight);
    expect(geometry.scoreText).toEqual(["안타 0", "홈런 0"]);
    expect(geometry.hudMetrics).not.toContain("안타 0");
    expect(geometry.hudMetrics).not.toContain("홈런 0");
    expect(geometry.player.left).toBeGreaterThanOrEqual(geometry.voc.left);
    expect(geometry.player.right).toBeLessThan(geometry.voc.right);
    expect(geometry.bat.left).toBeGreaterThanOrEqual(0);
    expect(geometry.bat.right).toBeLessThan(geometry.navRight);
    expect(geometry.pitcher.left).toBeGreaterThan(geometry.player.right);
    expect(geometry.pitcher.right).toBeLessThanOrEqual(geometry.voc.right + 2);
    expect(geometry.pitcher.right).toBeLessThan(geometry.navRight);
    expect(geometry.player.bottom).toBeLessThan(geometry.voc.top);
    expect(geometry.pitcher.bottom).toBeLessThan(geometry.voc.top);
    expect(geometry.player.top).toBeGreaterThan(geometry.lastNavBottom + 16);
    expect(geometry.pitcher.top).toBeGreaterThan(geometry.lastNavBottom + 16);
    expect(geometry.voc.top - geometry.player.bottom).toBeGreaterThanOrEqual(8);
    expect(geometry.voc.top - geometry.player.bottom).toBeLessThanOrEqual(16);
    expect(geometry.hud.left).toBeGreaterThanOrEqual(geometry.navRight + 24);
    expect((geometry.player.left + geometry.player.right) / 2).toBeGreaterThanOrEqual(56);
    expect((geometry.player.left + geometry.player.right) / 2).toBeLessThanOrEqual(60);
    expect(geometry.player.width).toBeGreaterThanOrEqual(32);
    expect(geometry.player.height).toBeGreaterThanOrEqual(44);
    expect(geometry.pitcher.width).toBeGreaterThanOrEqual(30);
    expect(geometry.pitcher.height).toBeGreaterThanOrEqual(42);
    expect(geometry.outfielder.width).toBeGreaterThanOrEqual(26);
    expect(geometry.outfielder.height).toBeGreaterThanOrEqual(38);
    expect(
      (geometry.pitcher.left + geometry.pitcher.right) / 2 -
        (geometry.player.left + geometry.player.right) / 2,
    ).toBeGreaterThanOrEqual(160);
    expect(
      (geometry.pitcher.left + geometry.pitcher.right) / 2 -
        (geometry.player.left + geometry.player.right) / 2,
    ).toBeLessThanOrEqual(164);
    expect((geometry.outfielder.left + geometry.outfielder.right) / 2).toBeGreaterThanOrEqual(690);
    expect((geometry.outfielder.left + geometry.outfielder.right) / 2).toBeLessThanOrEqual(708);
    expect(geometry.fence.left).toBeGreaterThanOrEqual(1_207);
    expect(geometry.fence.left).toBeLessThanOrEqual(1_217);
    expect(geometry.pitcher.right).toBeLessThan(geometry.outfielder.left);
    expect(geometry.outfielder.right).toBeLessThan(geometry.fence.left);
    expect(geometry.bat.width).toBeGreaterThanOrEqual(28);
    expect(geometry.bat.height).toBeGreaterThanOrEqual(4);
    expect(geometry.bat.right - geometry.player.right).toBeGreaterThanOrEqual(10);
    expect(geometry.board.right).toBeGreaterThan(geometry.viewportWidth / 2);
    expect(geometry.board.width).toBeLessThanOrEqual(238);
    expect(geometry.board.height).toBeLessThanOrEqual(108);
    expect(Math.abs(geometry.board.right - geometry.fence.right)).toBeLessThanOrEqual(4);
    expect(Math.abs(geometry.board.bottom - geometry.fence.top)).toBeLessThanOrEqual(4);
    expect(geometry.board.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.overlayPointerEvents).toBe("none");
    expect(geometry.boardPaint).toMatchObject({
      background: "rgba(0, 0, 0, 0)",
      borderWidth: "0px",
      padding: "0px",
      shadow: "none",
    });
    expect(geometry.boardPaint.color).toBe(geometry.labelPaint.color);
    expect(geometry.boardPaint.fontSize).toBe(geometry.labelPaint.fontSize);
    expect(geometry.boardPaint.fontWeight).toBe(geometry.labelPaint.fontWeight);
    expect(geometry.boardPaint.lineHeight).toBe(geometry.labelPaint.lineHeight);
    expect(geometry.boardPaint.opacity).toBe(geometry.labelPaint.opacity);
    expect(geometry.scorePaint).toEqual(geometry.labelPaint);

    await capture(account.page, "visual-1280-desktop.png");
  });

  it("renders a continuous launch, arc, and descent for a batted ball", async () => {
    const account = await newAccountPage(
      "ball-flight",
      "ball_flight",
      {
        [BASEBALL_RPC.progress]: progress(),
        [BASEBALL_RPC.leaderboard]: leaderboard(),
        [BASEBALL_RPC.plateAppearance]: {
          awardedGold: 1,
          progress: progress({ gold: 1, revision: 1 }),
        },
      },
      { height: 800, width: 1280 },
    );
    await account.page.locator("platformclaw-easter-egg").evaluate((element) => {
      (element as HTMLElement & { random: () => number }).random = () => 0;
    });
    await openGame(account.page);
    const game = account.page.locator('platformclaw-easter-egg [role="application"]');
    await expect.poll(() => game.getAttribute("data-pitch-state")).toBe("pitch");
    await expect.poll(() => game.getByText("115km/h", { exact: true }).isVisible()).toBe(true);
    const pitchTiming = await baseballProof.readPitchTiming(
      account.page.locator("platformclaw-easter-egg"),
    );
    expect(pitchTiming.speedKph).toBe(115);
    expect(pitchTiming.idealContactTimeMs).toBeCloseTo((18.44 / (115 / 3.6)) * 1_000, 8);
    const releaseDelta = await account.page
      .locator("platformclaw-easter-egg")
      .evaluate((element) => {
        const gameElement = element as HTMLElement & {
          pitchElapsedMs: number;
          renderProjectile: () => void;
        };
        gameElement.pitchElapsedMs = 0;
        gameElement.renderProjectile();
        const centerX = (selector: string) => {
          const bounds = element.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
          if (!bounds) {
            throw new Error(`missing ${selector}`);
          }
          return bounds.left + bounds.width / 2;
        };
        return Math.abs(
          centerX(".platformclaw-easter-egg__projectile") -
            centerX(".platformclaw-easter-egg__target"),
        );
      });
    expect(releaseDelta).toBeLessThanOrEqual(1);
    expect(await baseballProof.readBaseballPaint(game)).toEqual({
      projectile: "rgb(0, 0, 0)",
      trail: ["rgb(0, 0, 0)"],
    });
    await capture(account.page, "visual-1280-light-pitch.png");
    await baseballProof.setThemeMode(account.page, "dark");
    expect(await baseballProof.readBaseballPaint(game)).toEqual({
      projectile: "rgb(255, 255, 255)",
      trail: ["rgb(255, 255, 255)"],
    });
    await capture(account.page, "visual-1280-dark-pitch.png");
    await baseballProof.setThemeMode(account.page, "light");
    const idleBatter = await baseballProof.readBatterPose(game);
    const contactDelta = await account.page
      .locator("platformclaw-easter-egg")
      .evaluate((element) => {
        const gameElement = element as HTMLElement & {
          animationFrame: number;
          renderProjectile: () => void;
          pitch?: { idealContactTimeMs: number };
          pitchElapsedMs: number;
          stopAnimationLoop: () => void;
        };
        if (!gameElement.pitch) {
          throw new Error("missing active pitch");
        }
        gameElement.pitchElapsedMs = gameElement.pitch.idealContactTimeMs + 40;
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", cancelable: true }));
        gameElement.stopAnimationLoop();
        gameElement.animationFrame = -1;
        gameElement.renderProjectile();
        const centerX = (selector: string) => {
          const bounds = element.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
          if (!bounds) {
            throw new Error(`missing ${selector}`);
          }
          return bounds.left + bounds.width / 2;
        };
        return Math.abs(
          centerX(".platformclaw-easter-egg__projectile") -
            centerX(".platformclaw-easter-egg__player"),
        );
      });
    expect(contactDelta).toBeLessThanOrEqual(1);
    await expect.poll(() => game.getAttribute("data-pitch-state")).toBe("in-play");
    await account.page.waitForTimeout(95);
    const contactBatter = await baseballProof.readBatterPose(game);
    await capture(account.page, "visual-1280-batter-contact.png");
    await account.page.waitForTimeout(110);
    const followBatter = await baseballProof.readBatterPose(game);
    await capture(account.page, "visual-1280-batter-follow.png");
    expect(baseballProof.summarizeBatterMotion(idleBatter, contactBatter, followBatter)).toEqual({
      contactChanged: true,
      contactPlanted: true,
      followChanged: true,
      followPlanted: true,
    });
    await account.page.locator("platformclaw-easter-egg").evaluate((element) => {
      const simulation = (
        element as HTMLElement & {
          battedBall?: { outfielder: { reactionDelayMs: number } };
        }
      ).battedBall;
      if (!simulation) {
        throw new Error("missing active batted-ball simulation");
      }
      simulation.outfielder.reactionDelayMs = Number.POSITIVE_INFINITY;
    });

    const ball = game.locator(".platformclaw-easter-egg__projectile");
    expect(await baseballProof.readBaseballPaint(game)).toEqual({
      projectile: "rgb(0, 0, 0)",
      trail: ["rgb(0, 0, 0)"],
    });
    const ballRect = async () => {
      const bounds = await ball.boundingBox();
      if (!bounds) {
        throw new Error("missing rendered baseball");
      }
      return bounds;
    };
    const launch = await ballRect();
    expect(launch.width).toBe(10);
    expect(launch.height).toBe(10);
    await capture(account.page, "visual-1280-ball-launch.png");
    await baseballProof.setThemeMode(account.page, "dark");
    expect(await baseballProof.readBaseballPaint(game)).toEqual({
      projectile: "rgb(255, 255, 255)",
      trail: ["rgb(255, 255, 255)"],
    });
    await capture(account.page, "visual-1280-dark-ball-launch.png");
    await account.page.locator("platformclaw-easter-egg").evaluate((element) => {
      const gameElement = element as HTMLElement & {
        animationFrame: number;
        ensureAnimationLoop: () => void;
      };
      gameElement.animationFrame = 0;
      gameElement.ensureAnimationLoop();
    });

    await account.page.waitForTimeout(900);
    const midflight = await ballRect();
    await capture(account.page, "visual-1280-ball-midflight.png");
    expect(midflight.x).toBeGreaterThan(launch.x + 30);
    expect(midflight.y).toBeLessThan(launch.y - 20);
    const visibleTrail = await game
      .locator(".platformclaw-easter-egg__trail-dot")
      .evaluateAll((elements) =>
        elements
          .filter((element) => getComputedStyle(element).opacity !== "0")
          .map((element) => ({
            x: element.getBoundingClientRect().x,
            scale: (element as HTMLElement).style.scale,
            transform: (element as HTMLElement).style.transform,
          })),
      );
    expect(visibleTrail.length).toBeGreaterThan(2);
    expect(Math.min(...visibleTrail.map(({ x }) => x))).toBeGreaterThanOrEqual(launch.x - 8);
    expect(visibleTrail.every(({ scale }) => scale === "")).toBe(true);
    expect(visibleTrail.every(({ transform }) => transform.includes(" scale("))).toBe(true);

    await expect
      .poll(async () => {
        const bounds = await ballRect();
        return bounds.y > midflight.y + 20;
      })
      .toBe(true);
    const descent = await ballRect();
    await capture(account.page, "visual-1280-ball-landing.png");
    expect(descent.x).toBeGreaterThan(midflight.x + 30);
    expect(descent.y).toBeGreaterThan(midflight.y + 20);
    const plateAppearance = await account.gateway.waitForRequest(BASEBALL_RPC.plateAppearance);
    expect(plateAppearance.params).toMatchObject({ outcome: "hit" });
    await expect.poll(() => game.getByText("골드 1", { exact: true }).isVisible()).toBe(true);
  });
});
