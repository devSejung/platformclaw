import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BASEBALL_RPC } from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { baseballSession, installBaseballDocument } from "./platformclaw-baseball.e2e-helpers.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(process.cwd(), ".artifacts/control-ui-e2e/baseball-pitches");
let browser: Browser;
let server: ControlUiE2eServer;
let context: BrowserContext;

async function capture(page: Page, name: string) {
  if (captureProof) {
    await page.screenshot({ path: path.join(artifactDir, name), fullPage: true });
  }
}

describeE2e("five baseball pitch patterns in a real browser with synthetic Gateway data", () => {
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

  it.each([
    { kind: "fastball", sample: 0.1171875, label: "직구", speed: 150 },
    { kind: "changeup", sample: 0.3515625, label: "체인지업", speed: 120 },
    { kind: "underhand", sample: 0.5859375, label: "언더핸드 패턴", speed: 135 },
    { kind: "curve", sample: 0.8203125, label: "커브", speed: 110 },
    { kind: "knuckleball", sample: 0.9765625, label: "너클볼", speed: 105 },
  ])(
    "hides $kind before contact, shares its contact point, and reveals it after hit or MISS",
    async ({ kind, sample, label, speed }) => {
      context = await browser.newContext({
        locale: "ko-KR",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 800 },
        recordVideo: captureProof
          ? { dir: artifactDir, size: { width: 1280, height: 800 } }
          : undefined,
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await installBaseballDocument(page, server.baseUrl);
      await page.route("**/platformclaw/api/auth/session", (route) =>
        route.fulfill({ json: baseballSession(`synthetic-${kind}`, "synthetic_agent") }),
      );
      const progress = {
        gold: 0,
        ownedBatIds: ["wood"],
        equippedBatId: "wood",
        totalHomers: 0,
        bestDistanceM: 0,
        currentHomeRunStreak: 0,
        bestHomeRunStreak: 0,
        revision: 0,
      };
      const atBat = {
        id: `${kind}-hit`,
        pitchSample: sample,
        batId: "wood",
        issuedAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
      const gateway = await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: "synthetic_agent",
        sessionKey: "agent:synthetic_agent:main",
        featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
        methodResponses: {
          [BASEBALL_RPC.progress]: progress,
          [BASEBALL_RPC.leaderboard]: { distance: [], homeRunStreak: [] },
          [BASEBALL_RPC.beginAtBat]: atBat,
          [BASEBALL_RPC.plateAppearance]: { awardedGold: 0, progress },
        },
      });
      await page.goto(`${server.baseUrl}platformclaw/app/chat`);
      const host = page.locator("platformclaw-easter-egg");
      await host.waitFor({ state: "attached" });
      await page.locator("openclaw-app-topbar .topbar-brand").evaluate(async (element) => {
        for (let index = 0; index < 7; index += 1) {
          (element as HTMLElement).click();
          await new Promise((resolve) => {
            window.setTimeout(resolve, 25);
          });
        }
      });
      await page.locator('[data-game-choice="baseball"]').waitFor();
      await host.evaluate((element) => {
        (element as HTMLElement & { random: () => number }).random = () => 0;
      });
      await page.locator('[data-game-choice="baseball"]').click();
      await page.locator(".platformclaw-easter-egg__shop-trigger").click();
      const frozen = new Date(await page.evaluate(() => Date.now() + 1000));
      await page.clock.install({ time: frozen });
      await page.clock.pauseAt(frozen);
      await page.locator(".platformclaw-easter-egg__shop header button").click();
      const game = host.locator('[role="application"]');
      expect(await game.evaluate((element) => document.activeElement === element)).toBe(true);
      const info = game.locator(".platformclaw-easter-egg__pitch-info");
      expect(await game.getAttribute("data-pitch-state")).toBe("ready");
      expect(await info.count()).toBe(0);
      await capture(page, `${kind}-00-ready-hidden.png`);
      for (
        let step = 0;
        step < 70 && (await game.getAttribute("data-pitch-state")) === "ready";
        step += 1
      ) {
        await page.clock.runFor(16);
      }
      expect(await game.getAttribute("data-pitch-state")).toBe("pitch");
      if (kind === "underhand") {
        expect(
          await game.locator(".platformclaw-easter-egg__target").getAttribute("class"),
        ).toContain("underhand-throw");
      }
      expect(await info.count()).toBe(0);
      const positions = [];
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        await host.evaluate((element, value) => {
          const actor = element as HTMLElement & {
            pitch: { idealContactTimeMs: number };
            pitchElapsedMs: number;
            trail: unknown[];
            stopAnimationLoop: () => void;
            renderProjectile: () => void;
            lastFrameAt: number;
            now: () => number;
          };
          actor.stopAnimationLoop();
          actor.trail = [];
          actor.pitchElapsedMs = actor.pitch.idealContactTimeMs * value;
          actor.lastFrameAt = actor.now();
          actor.renderProjectile();
        }, fraction);
        const ball = await game.locator(".platformclaw-easter-egg__projectile").boundingBox();
        expect(ball).not.toBeNull();
        positions.push({ x: ball!.x + ball!.width / 2, y: ball!.y + ball!.height / 2 });
        expect(await info.count()).toBe(0);
        await capture(
          page,
          `${kind}-${Math.round(fraction * 100)
            .toString()
            .padStart(3, "0")}-flight-hidden.png`,
        );
      }
      const player = await game.locator(".platformclaw-easter-egg__player").boundingBox();
      expect(Math.abs(positions[4]!.x - (player!.x + player!.width / 2))).toBeLessThanOrEqual(1);
      if (kind === "underhand") {
        expect(positions[4]!.y).toBeLessThan(positions[0]!.y - 5);
        for (let index = 1; index < positions.length; index += 1) {
          expect(positions[index - 1]!.y - positions[index]!.y).toBeCloseTo(
            (positions[0]!.y - positions[4]!.y) / 4,
            5,
          );
        }
      } else {
        expect(positions[4]!.y).toBeCloseTo(positions[0]!.y, 5);
      }
      for (let index = 1; index < positions.length; index += 1) {
        expect(positions[index - 1]!.x - positions[index]!.x).toBeCloseTo(
          (positions[0]!.x - positions[4]!.x) / 4,
          5,
        );
      }
      await gateway.deferNext(BASEBALL_RPC.plateAppearance);
      if (kind === "fastball") {
        await page.evaluate(() => {
          const input = document.createElement("input");
          input.id = "synthetic-pitch-input";
          document.body.append(input);
          input.focus();
        });
        await page.keyboard.down("ControlLeft");
        await page.keyboard.up("ControlLeft");
        expect(await game.getAttribute("data-pitch-state")).toBe("pitch");
        await page.locator("#synthetic-pitch-input").evaluate((element) => element.remove());
        await game.focus();
      }
      if (kind === "fastball" || kind === "underhand") {
        const key = kind === "fastball" ? "ControlLeft" : "ControlRight";
        await page.keyboard.down(key);
        expect(await game.getAttribute("data-pitch-state")).toBe("in-play");
        await page.keyboard.up(key);
      } else if (kind === "changeup") {
        await page.mouse.click(player!.x + player!.width / 2, player!.y + player!.height / 2);
      } else {
        await page.keyboard.press("Space");
      }
      await expect.poll(() => game.getAttribute("data-pitch-state")).toBe("in-play");
      expect(await info.textContent()).toContain(label);
      expect(await info.textContent()).toContain(`${speed}km/h`);
      await capture(page, `${kind}-contact-revealed.png`);
      await host.evaluate((element) => {
        (element as HTMLElement & { ensureAnimationLoop: () => void }).ensureAnimationLoop();
      });
      await page.clock.runFor(8000);
      const hitRequests = await gateway.getRequests(BASEBALL_RPC.plateAppearance);
      expect(hitRequests).toHaveLength(1);
      expect(hitRequests[0]!.params).toMatchObject({ atBatId: atBat.id, timingDeltaMs: 0 });
      await gateway.resolveDeferred(BASEBALL_RPC.plateAppearance);
      await page.keyboard.press("Escape");
      await gateway.setMethodResponse(BASEBALL_RPC.beginAtBat, { ...atBat, id: `${kind}-miss` });
      await host.evaluate(() => window.dispatchEvent(new Event("platformclaw:easter-egg")));
      await page.locator('[data-game-choice="baseball"]').click();
      await page.clock.runFor(20);
      expect(await info.count()).toBe(0);
      await page.clock.runFor(710 + (18.44 / (speed / 3.6)) * 1000 + 132);
      expect(await game.getAttribute("data-pitch-state")).toBe("result");
      expect(await info.textContent()).toContain(label);
      expect(await info.textContent()).toContain(`${speed}km/h`);
      const missRequests = await gateway.getRequests(BASEBALL_RPC.plateAppearance);
      expect(missRequests.at(-1)!.params).toMatchObject({
        atBatId: `${kind}-miss`,
        timingDeltaMs: null,
      });
      await capture(page, `${kind}-miss-revealed.png`);
      expect(pageErrors).toEqual([]);
    },
  );
});
