import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BASEBALL_RPC,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { getBaseballEnhancementAppearance } from "../../../packages/platformclaw-control-plane/src/baseball-enhancement.ts";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  baseballSession,
  installBaseballDocument,
  setThemeMode,
} from "./platformclaw-baseball.e2e-helpers.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(process.cwd(), ".artifacts/control-ui-e2e/baseball-enhancement");
let browser: Browser;
let server: ControlUiE2eServer;
let context: BrowserContext;

function progress(level?: number, overrides: Partial<BaseballProgress> = {}): BaseballProgress {
  return {
    gold: 50_000,
    ownedBatIds: ["wood", "silver", "diamond"],
    equippedBatId: "diamond",
    totalHomers: 24,
    bestDistanceM: 151,
    currentHomeRunStreak: 2,
    bestHomeRunStreak: 6,
    revision: 30,
    ...(level === undefined
      ? {}
      : { enhancement: { level, status: "ready" as const, equipped: true, version: 1 as const } }),
    ...overrides,
  };
}

async function capture(page: Page, name: string): Promise<void> {
  if (captureProof) {
    await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
  }
}

async function readablePause(page: Page): Promise<void> {
  if (captureProof) {
    await page.waitForTimeout(900);
  }
}

async function openWorkshop(page: Page): Promise<void> {
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
  const dialog = page.getByRole("dialog", { name: "배트 강화·설정" });
  if (!(await dialog.isVisible())) {
    await page.locator(".platformclaw-easter-egg__shop-trigger").click();
  }
  await page.getByRole("dialog", { name: "배트 강화·설정" }).waitFor();
}

async function setup(page: Page, initial: BaseballProgress) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installBaseballDocument(page, server.baseUrl);
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({ json: baseballSession("synthetic-forge", "synthetic_agent") }),
  );
  const gateway = await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: "synthetic_agent",
    sessionKey: "agent:synthetic_agent:main",
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    methodResponses: {
      [BASEBALL_RPC.progress]: initial,
      [BASEBALL_RPC.leaderboard]: { distance: [], homeRunStreak: [] },
      [BASEBALL_RPC.beginAtBat]: {
        id: "synthetic-forge-at-bat",
        pitchSample: 0.1171875,
        batId: initial.enhancement?.equipped
          ? getBaseballEnhancementAppearance(initial.enhancement.level).batId
          : initial.equippedBatId,
        ...(initial.enhancement?.equipped
          ? { enhancementLevel: initial.enhancement.level, powerRuleVersion: "sweetspot-v1" }
          : {}),
        issuedAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      [BASEBALL_RPC.plateAppearance]: { awardedGold: 0, progress: initial },
    },
  });
  await page.goto(`${server.baseUrl}platformclaw/app/chat`);
  await openWorkshop(page);
  return { gateway, pageErrors };
}

describeE2e("enhancement workshop in notebook Chrome with synthetic server receipts", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    await mkdir(artifactDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });
  afterEach(async () => {
    await context?.close();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("opts in freely, charges only confirmed attempts, retries one receipt, and evolves in light and dark themes", async () => {
    context = await browser.newContext({
      locale: "ko-KR",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
      recordVideo: captureProof
        ? { dir: artifactDir, size: { width: 1280, height: 800 } }
        : undefined,
    });
    const page = await context.newPage();
    const { gateway, pageErrors } = await setup(page, progress());
    const forge = page.locator(".platformclaw-baseball-forge");
    const preview = forge.locator(".platformclaw-baseball-forge__preview");
    await setThemeMode(page, "light");
    await page.locator("[data-forge-equip]").waitFor();
    await capture(page, "01-free-opt-in-light");
    await readablePause(page);
    const started = progress(0, { revision: 31 });
    await gateway.setMethodResponse(BASEBALL_RPC.equipEnhancedBat, {
      requestId: "synthetic-start",
      changed: true,
      progress: started,
    });
    await page.locator("[data-forge-equip]").click();
    await expect.poll(() => forge.textContent()).toContain("강화 배트 +0 장착");
    expect(await forge.textContent()).toContain("골드 50,000G");
    await gateway.setMethodResponse(BASEBALL_RPC.enhanceBat, {
      __mockError: { code: "UNAVAILABLE", message: "Synthetic lost response" },
    });
    await page.locator("[data-forge-enhance]").click();
    await page.getByText("강화 결과 확인 실패", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "취소", exact: true }).count()).toBe(0);
    await page.locator(".platformclaw-easter-egg__shop header button").click();
    expect(await page.getByRole("dialog", { name: "배트 강화·설정" }).isVisible()).toBe(false);
    await page.locator(".platformclaw-easter-egg__shop-trigger").click();
    await page.keyboard.press("Escape");
    expect(await page.getByRole("dialog", { name: "배트 강화·설정" }).isVisible()).toBe(false);
    await page.locator(".platformclaw-easter-egg__shop-trigger").click();
    expect(await preview.getAttribute("data-effect")).toBe("");
    expect(await forge.textContent()).toContain("골드 50,000G");
    await capture(page, "02-unknown-response-no-speculative-result");
    await readablePause(page);
    await page.locator(".platformclaw-easter-egg__shop header button").click();
    const maintained = progress(0, { gold: 49_900, revision: 32 });
    await gateway.setMethodResponse(BASEBALL_RPC.progress, {
      ...maintained,
      gold: 49_850,
      revision: 33,
      teamId: "lg",
    });
    await gateway.setMethodResponse(BASEBALL_RPC.enhanceBat, {
      requestId: "synthetic-maintain",
      outcome: "maintain",
      fromLevel: 0,
      targetLevel: 1,
      level: 0,
      chargedGold: 100,
      evolved: false,
      automaticRestart: false,
      progress: maintained,
    });
    await page.getByRole("button", { name: "재시도", exact: true }).click();
    await page.locator("[data-forge-taunt]").waitFor();
    expect(await page.getByRole("dialog", { name: "배트 강화·설정" }).count()).toBe(0);
    await capture(page, "21-confirmed-failure-taunt-outside-workshop");
    await page.locator(".platformclaw-easter-egg__shop-trigger").click();
    await page.locator('[data-forge-result="maintain"]').waitFor();
    expect(await forge.textContent()).toContain("골드 49,850G");
    expect(await page.locator('[role="application"]').getAttribute("data-team-id")).toBe("lg");
    const attempts = await gateway.getRequests(BASEBALL_RPC.enhanceBat);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.params).toEqual(attempts[0]!.params);
    expect(attempts[0]!.params).toMatchObject({ expectedRevision: 31 });
    const taunt = page.locator("[data-forge-taunt]");
    expect([
      "줴줴이야~",
      "ㅋㅋ",
      "ㅋ",
      "ㅋㅋㄹㅇ",
      "어림없지",
      "다시 와라",
      "ㅈㄴ못하네~",
    ]).toContain((await taunt.textContent())?.trim());
    expect(await page.locator("[data-forge-enhance]").isEnabled()).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await taunt.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    expect(await taunt.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
    await capture(page, "19-confirmed-failure-taunt-reduced-motion");
    await capture(page, "03-paid-maintain-confirmed");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await readablePause(page);

    // Separate synthetic +2 seed exercises the tier boundary; no production account is migrated.
    await gateway.setMethodResponse(
      BASEBALL_RPC.progress,
      progress(2, { gold: 49_850, revision: 34, teamId: "lg" }),
    );
    await gateway.setMethodResponse(BASEBALL_RPC.beginAtBat, {
      id: "synthetic-plus2-at-bat",
      pitchSample: 0.1171875,
      batId: "wood",
      enhancementLevel: 2,
      powerRuleVersion: "sweetspot-v1",
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    await page.reload();
    await openWorkshop(page);
    await setThemeMode(page, "dark");
    const silver = progress(3, { gold: 49_650, revision: 35, teamId: "lg" });
    await gateway.setMethodResponse(BASEBALL_RPC.enhanceBat, {
      requestId: "synthetic-evolution",
      outcome: "success",
      fromLevel: 2,
      targetLevel: 3,
      level: 3,
      chargedGold: 200,
      evolved: true,
      automaticRestart: false,
      progress: silver,
    });
    await page.locator("[data-forge-enhance]").click();
    await page.locator('[data-forge-result="success"]').waitFor();
    expect(await preview.getAttribute("data-appearance")).toBe("silver");
    expect(await preview.getAttribute("data-effect")).toBe("evolution");
    await capture(page, "04-silver-evolution-dark");
    await expect.poll(() => preview.getAttribute("data-effect")).toBe("");
    await readablePause(page);
    expect(await page.locator('[data-forge-result="success"]').textContent()).toContain("진화!");
    await page.getByText("전체 강화 확률·비용", { exact: true }).click();
    expect(await forge.locator("tbody tr").count()).toBe(20);
    await capture(page, "05-probability-table-dark");
    await page.getByText("전체 강화 확률·비용", { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "06-mobile-forge");
    expect(await page.locator("[data-forge-enhance]").isEnabled()).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  it.each(["reload", "close tab"] as const)(
    "recovers the same paid request after %s",
    async (exit) => {
      context = await browser.newContext({
        locale: "ko-KR",
        viewport: { width: 1280, height: 800 },
      });
      let page = await context.newPage();
      let { gateway } = await setup(page, progress(0));
      await gateway.setMethodResponse(BASEBALL_RPC.enhanceBat, {
        __mockError: { code: "UNAVAILABLE", message: "Synthetic committed response lost" },
      });
      await page.locator("[data-forge-enhance]").click();
      await page.getByText("강화 결과 확인 실패", { exact: true }).waitFor();
      const original = (await gateway.getRequests(BASEBALL_RPC.enhanceBat))[0]!.params;
      const committed = progress(1, { gold: 49_900, revision: 31 });
      if (exit === "reload") {
        await page.reload();
        await openWorkshop(page);
      } else {
        await page.close();
        page = await context.newPage();
        ({ gateway } = await setup(page, committed));
      }
      await page.getByText("미확정 요청 · 같은 요청으로 결과 확인", { exact: true }).waitFor();
      await gateway.setMethodResponse(BASEBALL_RPC.progress, committed);
      await gateway.setMethodResponse(BASEBALL_RPC.enhanceBat, {
        requestId: (original as { requestId: string }).requestId,
        outcome: "success",
        fromLevel: 0,
        targetLevel: 1,
        level: 1,
        chargedGold: 100,
        evolved: false,
        automaticRestart: false,
        progress: committed,
      });
      await page.getByRole("button", { name: "재시도", exact: true }).click();
      await page.locator('[data-forge-result="success"]').waitFor();
      const requests = await gateway.getRequests(BASEBALL_RPC.enhanceBat);
      expect(requests.at(-1)!.params).toEqual(original);
      expect(await page.locator(".platformclaw-baseball-forge").textContent()).toContain(
        "골드 49,900G",
      );
      expect(await page.locator("[data-forge-taunt]").count()).toBe(0);
      await capture(
        page,
        exit === "reload"
          ? "17-paid-request-recovered-after-reload"
          : "18-paid-request-recovered-after-tab-close",
      );
    },
  );

  it("coordinates two pending receipts and one taunt across real Chrome tabs", async () => {
    context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1280, height: 800 } });
    const first = await context.newPage();
    const second = await context.newPage();
    const { gateway: firstGateway } = await setup(first, progress(0));
    const { gateway: secondGateway } = await setup(second, progress(0));
    const maintained = progress(0, { gold: 49_900, revision: 31 });
    const failure = {
      requestId: "synthetic-queue-a",
      outcome: "maintain",
      fromLevel: 0,
      targetLevel: 1,
      level: 0,
      chargedGold: 100,
      evolved: false,
      automaticRestart: false,
      progress: maintained,
    };
    for (const gateway of [firstGateway, secondGateway]) {
      await gateway.setMethodResponse(BASEBALL_RPC.enhanceBat, failure);
      await gateway.deferNext(BASEBALL_RPC.enhanceBat);
    }
    await first.locator("platformclaw-easter-egg").evaluate((element) => {
      const scope = (element as HTMLElement & { preferenceScope: string }).preferenceScope;
      for (const [requestId, expectedRevision, createdAt] of [
        ["synthetic-queue-a", 30, 1],
        ["synthetic-queue-b", 31, 2],
      ] as const) {
        const key = `platformclaw.baseball.pending.v1:${encodeURIComponent(scope)}:${requestId}`;
        localStorage.setItem(
          key,
          JSON.stringify({
            method: "platformclaw.baseball.enhanceBat",
            params: { requestId, expectedRevision },
            createdAt,
          }),
        );
        window.dispatchEvent(new StorageEvent("storage", { key }));
      }
    });
    for (const page of [first, second]) {
      await page.getByText("미확정 요청 · 같은 요청으로 결과 확인", { exact: true }).waitFor();
      await page.getByRole("button", { name: "재시도", exact: true }).click();
    }
    await expect
      .poll(
        async () =>
          (await firstGateway.getRequests(BASEBALL_RPC.enhanceBat)).length +
          (await secondGateway.getRequests(BASEBALL_RPC.enhanceBat)).length,
      )
      .toBe(2);
    for (const gateway of [firstGateway, secondGateway]) {
      expect((await gateway.getRequests(BASEBALL_RPC.enhanceBat))[0]!.params).toMatchObject({
        requestId: "synthetic-queue-a",
        expectedRevision: 30,
      });
    }
    await firstGateway.setMethodResponse(BASEBALL_RPC.progress, maintained);
    await secondGateway.setMethodResponse(BASEBALL_RPC.progress, maintained);
    await Promise.all([
      firstGateway.resolveDeferred(BASEBALL_RPC.enhanceBat),
      secondGateway.resolveDeferred(BASEBALL_RPC.enhanceBat),
    ]);
    for (const page of [first, second]) {
      await expect
        .poll(() =>
          page.locator("platformclaw-easter-egg").evaluate(
            (element) =>
              (
                element as HTMLElement & {
                  pendingMutation: { params: { requestId: string } } | null;
                }
              ).pendingMutation?.params.requestId,
          ),
        )
        .toBe("synthetic-queue-b");
    }
    await expect
      .poll(
        async () =>
          (await first.locator("[data-forge-taunt]").count()) +
          (await second.locator("[data-forge-taunt]").count()),
      )
      .toBe(1);
    await capture(
      (await first.locator("[data-forge-taunt]").count()) ? first : second,
      "20-two-tabs-one-taunt-pending-queue",
    );
    const confirmed = progress(1, { gold: 49_800, revision: 32 });
    for (const gateway of [firstGateway, secondGateway]) {
      await gateway.setMethodResponse(BASEBALL_RPC.progress, confirmed);
    }
    await firstGateway.setMethodResponse(BASEBALL_RPC.enhanceBat, {
      ...failure,
      requestId: "synthetic-queue-b",
      outcome: "success",
      level: 1,
      progress: confirmed,
    });
    await first.getByRole("button", { name: "재시도", exact: true }).click();
    await first.locator('[data-forge-result="success"]').waitFor();
    for (const page of [first, second]) {
      await expect
        .poll(() =>
          page
            .locator("platformclaw-easter-egg")
            .evaluate(
              (element) => (element as HTMLElement & { pendingMutation: unknown }).pendingMutation,
            ),
        )
        .toBeNull();
      await expect
        .poll(() => page.locator(".platformclaw-baseball-forge").textContent())
        .toContain("골드 49,800G");
    }
  });

  it("shows normal destruction and paid restore without changing saved records", async () => {
    context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const initial = progress(15);
    const { gateway, pageErrors } = await setup(page, initial);
    const broken = progress(0, {
      gold: 40_000,
      revision: 31,
      enhancement: { level: 0, status: "broken", equipped: true, version: 1 },
    });
    await gateway.setMethodResponse(BASEBALL_RPC.enhanceBat, {
      requestId: "synthetic-destroy",
      outcome: "destroy",
      fromLevel: 15,
      targetLevel: 16,
      level: 0,
      chargedGold: 10_000,
      evolved: false,
      automaticRestart: false,
      progress: broken,
    });
    await page.locator("[data-forge-enhance]").click();
    await page.locator('[data-forge-result="destroy"]').waitFor();
    await page.locator('[data-forge-recover="restore"]').waitFor();
    await capture(page, "07-normal-destroy-recovery-choice");
    const restored = progress(12, { gold: 25_000, revision: 32 });
    await gateway.setMethodResponse(BASEBALL_RPC.recoverBat, {
      requestId: "synthetic-restore",
      outcome: "restored",
      chargedGold: 15_000,
      progress: restored,
    });
    await page.locator('[data-forge-recover="restore"]').click();
    await page.locator('[data-forge-result="restored"]').waitFor();
    await capture(page, "08-restored-titanium-plus12");
    expect(
      await page.locator("[data-enhancement-level]").getAttribute("data-enhancement-level"),
    ).toBe("12");
    expect(await page.locator(".platformclaw-baseball-forge").textContent()).toContain(
      "골드 25,000G",
    );
    const request = await gateway.getRequests(BASEBALL_RPC.recoverBat);
    expect(request[0]!.params).toMatchObject({ action: "restore", expectedRevision: 31 });
    expect(restored.ownedBatIds).toEqual(initial.ownedBatIds);
    expect(restored.totalHomers).toBe(initial.totalHomers);
    expect(pageErrors).toEqual([]);
  });

  it("renders star diamond at +20, snapshots the field, and respects reduced motion", async () => {
    context = await browser.newContext({
      locale: "ko-KR",
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const { pageErrors } = await setup(page, progress(20));
    await setThemeMode(page, "light");
    const preview = page.locator(".platformclaw-baseball-forge__preview");
    await page.locator("[data-forge-max]").waitFor();
    expect(await page.locator("[data-forge-enhance]").count()).toBe(0);
    expect(await preview.getAttribute("data-appearance")).toBe("star-diamond");
    expect(await preview.evaluate((element) => getComputedStyle(element).animationName)).toBe(
      "none",
    );
    await capture(page, "09-max-star-diamond-light");
    await setThemeMode(page, "dark");
    await capture(page, "10-max-star-diamond-dark");
    await page.locator(".platformclaw-easter-egg__shop header button").click();
    expect(await page.locator('[role="application"]').getAttribute("data-round-enhancement")).toBe(
      "20",
    );
    expect(await page.locator('[role="application"]').getAttribute("data-bat-appearance")).toBe(
      "star-diamond",
    );
    await capture(page, "11-snapshotted-star-diamond-field");
    expect(pageErrors).toEqual([]);
  });

  it("shows the approved drop landing and total destruction with reduced motion", async () => {
    context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const { gateway, pageErrors } = await setup(page, progress(17));
    await gateway.setMethodResponse(BASEBALL_RPC.enhanceBat, {
      requestId: "synthetic-drop",
      outcome: "drop",
      fromLevel: 17,
      targetLevel: 18,
      level: 15,
      chargedGold: 15_000,
      evolved: false,
      automaticRestart: false,
      progress: progress(15, { gold: 35_000, revision: 31 }),
    });
    await page.locator("[data-forge-enhance]").click();
    await page.locator('[data-forge-result="drop"]').waitFor();
    expect(
      await page.locator("[data-enhancement-level]").getAttribute("data-enhancement-level"),
    ).toBe("15");
    await capture(page, "12-drop-target18-to-plus15");
    await gateway.setMethodResponse(BASEBALL_RPC.progress, progress(17));
    await page.reload();
    await openWorkshop(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gateway.setMethodResponse(BASEBALL_RPC.enhanceBat, {
      requestId: "synthetic-total-destroy",
      outcome: "total_destroy",
      fromLevel: 17,
      targetLevel: 18,
      level: 0,
      chargedGold: 15_000,
      evolved: false,
      automaticRestart: false,
      progress: progress(0, { gold: 35_000, revision: 31 }),
    });
    await page.locator("[data-forge-enhance]").click();
    await page.locator('[data-forge-result="total_destroy"]').waitFor();
    expect(
      await page.locator("[data-enhancement-level]").getAttribute("data-enhancement-level"),
    ).toBe("0");
    expect(await page.locator("[data-forge-recover]").count()).toBe(0);
    expect(
      await page
        .locator(".platformclaw-baseball-forge__shards")
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("none");
    expect(await page.locator(".platformclaw-baseball-forge").textContent()).toContain(
      "골드 35,000G",
    );
    await capture(page, "13-total-destroy-free0-reduced-motion");
    expect(pageErrors).toEqual([]);
  });

  it("resumes a legacy pitch after unequipping a broken enhancement without a recovery charge", async () => {
    context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const initial = progress(0, {
      enhancement: { level: 0, status: "broken", equipped: true, version: 1 },
    });
    const { gateway, pageErrors } = await setup(page, initial);
    expect(await gateway.getRequests(BASEBALL_RPC.beginAtBat)).toHaveLength(0);
    const legacy = progress(0, {
      revision: 31,
      enhancement: { level: 0, status: "broken", equipped: false, version: 1 },
    });
    await gateway.setMethodResponse(BASEBALL_RPC.equipBat, {
      batId: "diamond",
      changed: true,
      progress: legacy,
    });
    await gateway.setMethodResponse(BASEBALL_RPC.beginAtBat, {
      id: "synthetic-legacy-after-broken",
      pitchSample: 0.1171875,
      batId: "diamond",
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    await page.getByText("기존 보유 배트", { exact: true }).click();
    await page.locator('[data-shop-bat="diamond"]').click();
    await expect
      .poll(() => page.locator('[data-shop-bat="diamond"]').textContent())
      .toContain("장착 중");
    await capture(page, "15-broken-enhancement-legacy-equipped");
    await page.locator(".platformclaw-easter-egg__shop header button").click();
    const game = page.locator('[role="application"]');
    await expect.poll(() => game.getAttribute("data-pitch-state")).toBe("pitch");
    expect(await game.getAttribute("data-bat-id")).toBe("diamond");
    expect(await game.getAttribute("data-round-enhancement")).toBeNull();
    expect(await game.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await gateway.getRequests(BASEBALL_RPC.beginAtBat)).toHaveLength(1);
    expect(await gateway.getRequests(BASEBALL_RPC.recoverBat)).toHaveLength(0);
    expect(await game.textContent()).toContain("골드 50000");
    await capture(page, "16-legacy-pitch-resumed-after-broken-enhancement");
    expect(pageErrors).toEqual([]);
  });

  it("records the two-second floating failure taunt in notebook Chrome", async () => {
    context = await browser.newContext({
      locale: "ko-KR",
      viewport: { width: 1280, height: 800 },
      recordVideo: captureProof
        ? { dir: artifactDir, size: { width: 1280, height: 800 } }
        : undefined,
    });
    const createdAt = Date.now();
    const page = await context.newPage();
    const { gateway, pageErrors } = await setup(page, progress(0));
    await setThemeMode(page, "light");
    // Seed only the display-time selector; the synthetic server receipt owns the economic outcome.
    await page.evaluate(() => {
      Math.random = () => 0.999;
    });
    let revision = 30;
    const fail = async () => {
      revision += 1;
      await gateway.setMethodResponse(BASEBALL_RPC.enhanceBat, {
        requestId: `synthetic-floating-${revision}`,
        outcome: "maintain",
        fromLevel: 0,
        targetLevel: 1,
        level: 0,
        chargedGold: 100,
        evolved: false,
        automaticRestart: false,
        progress: progress(0, { gold: 50_000 - (revision - 30) * 100, revision }),
      });
      await page.locator("[data-forge-enhance]").click();
      await page.locator("[data-forge-taunt]").waitFor();
    };
    const clearOfControls = async () => {
      const geometry = await page.evaluate(() => {
        const box = document.querySelector("[data-forge-taunt] span")!.getBoundingClientRect();
        return {
          taunt: { x: box.x, y: box.y, right: box.right, bottom: box.bottom },
          width: innerWidth,
          height: innerHeight,
          protected: [
            ".platformclaw-easter-egg__shop",
            ".platformclaw-easter-egg__player",
            ".platformclaw-easter-egg__projectile",
            ".platformclaw-easter-egg__hud",
            ".platformclaw-easter-egg__result",
            ".platformclaw-easter-egg__shop-trigger",
            ".platformclaw-games-nav",
          ]
            .flatMap((selector) =>
              Array.from(document.querySelectorAll(selector)).map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                  selector,
                  x: rect.x,
                  y: rect.y,
                  right: rect.right,
                  bottom: rect.bottom,
                  width: rect.width,
                  height: rect.height,
                };
              }),
            )
            .filter((rect) => rect.width > 0 && rect.height > 0),
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(geometry.taunt.x).toBeGreaterThanOrEqual(0);
      expect(geometry.taunt.y).toBeGreaterThanOrEqual(0);
      expect(geometry.taunt.right).toBeLessThanOrEqual(geometry.width);
      expect(geometry.taunt.bottom).toBeLessThanOrEqual(geometry.height);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
      for (const rect of geometry.protected) {
        const overlaps =
          geometry.taunt.x < rect.right &&
          geometry.taunt.right > rect.x &&
          geometry.taunt.y < rect.bottom &&
          geometry.taunt.bottom > rect.y;
        expect(overlaps, `taunt must not cover ${rect.selector}`).toBe(false);
      }
      return geometry;
    };
    await page.waitForTimeout(500);
    await fail();
    const confirmedAtMs = Date.now() - createdAt;
    const taunt = page.locator("[data-forge-taunt]");
    const lettering = taunt.locator("span");
    expect((await taunt.textContent())?.trim()).toBe("ㅈㄴ못하네~");
    expect(await taunt.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
    expect(await lettering.evaluate((element) => getComputedStyle(element).animationDuration)).toBe(
      "2s",
    );
    expect(await page.locator("[data-forge-enhance]").isEnabled()).toBe(true);
    const initialTransform = await lettering.evaluate(
      (element) => getComputedStyle(element).transform,
    );
    await page.waitForTimeout(550);
    const desktopGeometry = await clearOfControls();
    const movingTransform = await lettering.evaluate(
      (element) => getComputedStyle(element).transform,
    );
    expect(movingTransform).not.toBe(initialTransform);
    await capture(page, "22-floating-taunt-desktop");
    await page.locator(".platformclaw-easter-egg__shop header button").click();
    await page.waitForTimeout(350);
    const closedGeometry = await clearOfControls();
    await capture(page, "25-floating-taunt-shop-closed");
    await expect.poll(() => taunt.count(), { timeout: 3_000 }).toBe(0);
    const disappearedAtMs = Date.now() - createdAt;
    await page.waitForTimeout(1_500);
    const mobileGeometry = [];
    for (const height of [844, 568]) {
      await page.setViewportSize({ width: 390, height });
      await page.locator(".platformclaw-easter-egg__shop-trigger").click();
      await fail();
      await page.waitForTimeout(450);
      mobileGeometry.push(await clearOfControls());
      if (height === 844) {
        await capture(page, "23-floating-taunt-mobile");
      }
      await expect.poll(() => taunt.count(), { timeout: 3_000 }).toBe(0);
      await page.locator(".platformclaw-easter-egg__shop header button").click();
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(".platformclaw-easter-egg__shop-trigger").click();
    await page.evaluate(() => {
      Math.random = () => 0.5;
    });
    await fail();
    expect(await lettering.evaluate((element) => getComputedStyle(element).animationName)).toBe(
      "none",
    );
    const stillBefore = await lettering.boundingBox();
    await page.waitForTimeout(550);
    expect(await lettering.boundingBox()).toEqual(stillBefore);
    await clearOfControls();
    await capture(page, "24-floating-taunt-reduced-motion");
    await expect.poll(() => taunt.count(), { timeout: 3_000 }).toBe(0);
    expect(pageErrors).toEqual([]);
    if (captureProof) {
      await writeFile(
        path.join(artifactDir, "floating-taunt-cue.json"),
        JSON.stringify(
          {
            video: await page.video()!.path(),
            confirmedAtMs,
            disappearedAtMs,
            desktopGeometry,
            closedGeometry,
            mobileGeometry,
            note: "Actual notebook Chrome, natural wall clock; no virtual clock or composited frames. Synthetic maintain receipts; display-only Math.random seeded to select the requested phrase. Only leading startup is trimmed in the shared excerpt.",
          },
          null,
          2,
        ),
      );
    }
  });

  it("records readable confirmed enhancement outcomes in one continuous natural-clock session", async () => {
    context = await browser.newContext({
      locale: "ko-KR",
      viewport: { width: 1280, height: 800 },
      recordVideo: captureProof
        ? { dir: artifactDir, size: { width: 1280, height: 800 } }
        : undefined,
    });
    const createdAt = Date.now();
    const page = await context.newPage();
    const { gateway, pageErrors } = await setup(page, progress(2, { gold: 25_000 }));
    await setThemeMode(page, "light");
    const readyAtMs = Date.now() - createdAt;
    const hold = async () => {
      if (captureProof) {
        await page.waitForTimeout(2_200);
      }
    };
    await hold();
    let gold = 25_000;
    let revision = 30;
    const preview = page.locator(".platformclaw-baseball-forge__preview");
    for (const step of [
      { from: 2, target: 3, level: 3, cost: 200, outcome: "success", evolved: true },
      { from: 3, target: 4, level: 3, cost: 300, outcome: "maintain", evolved: false },
      { from: 3, target: 4, level: 2, cost: 300, outcome: "drop", evolved: false },
      { from: 2, target: 3, level: 3, cost: 200, outcome: "success", evolved: true },
      { from: 3, target: 4, level: 0, cost: 300, outcome: "total_destroy", evolved: false },
    ]) {
      gold -= step.cost;
      revision += 1;
      await gateway.setMethodResponse(BASEBALL_RPC.enhanceBat, {
        requestId: `synthetic-recording-${revision}`,
        outcome: step.outcome,
        fromLevel: step.from,
        targetLevel: step.target,
        level: step.level,
        chargedGold: step.cost,
        evolved: step.evolved,
        automaticRestart: false,
        progress: progress(step.level, { gold, revision }),
      });
      await page.locator("[data-forge-enhance]").click();
      await page.locator(`[data-forge-result="${step.outcome}"]`).waitFor();
      expect(
        await page.locator("[data-enhancement-level]").getAttribute("data-enhancement-level"),
      ).toBe(String(step.level));
      if (revision === 31) {
        await capture(page, "14-silver-evolution-light");
        await hold();
        await setThemeMode(page, "dark");
      }
      await hold();
    }
    await expect.poll(() => preview.getAttribute("data-effect")).toBe("");
    expect(pageErrors).toEqual([]);
    if (captureProof) {
      await writeFile(
        path.join(artifactDir, "recording-cue.json"),
        JSON.stringify(
          {
            video: await page.video()!.path(),
            readyAtMs,
            note: "Natural wall clock; no Playwright clock or source-state overrides. Only leading startup may be trimmed from the shareable excerpt.",
          },
          null,
          2,
        ),
      );
    }
  });
});
