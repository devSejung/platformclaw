import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { BASEBALL_RPC } from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { baseballSession, installBaseballDocument } from "./platformclaw-baseball.e2e-helpers.ts";

const rounds = [
  { kind: "fastball", sample: 0.1171875, key: null },
  { kind: "changeup", sample: 0.3515625, key: "Space" },
  { kind: "underhand", sample: 0.5859375, key: "ControlLeft" },
  { kind: "curve", sample: 0.8203125, key: null },
  { kind: "knuckleball", sample: 0.9765625, key: "ControlRight" },
] as const;

it("keeps five consecutive pitches moving through natural MISS and Space/Ctrl contact without reopening", async () => {
  const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
  const artifactDir = path.resolve(".artifacts/control-ui-e2e/baseball-rounds");
  if (capture) {
    await mkdir(artifactDir, { recursive: true });
  }
  const server = await startControlUiE2eServer();
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  const browser = await chromium.launch({ executablePath });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "ko-KR",
    serviceWorkers: "block",
    recordVideo: capture ? { dir: artifactDir, size: { width: 1280, height: 800 } } : undefined,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const progress = {
    gold: 1000,
    ownedBatIds: ["wood"],
    equippedBatId: "wood",
    totalHomers: 0,
    bestDistanceM: 0,
    currentHomeRunStreak: 0,
    bestHomeRunStreak: 0,
    revision: 0,
    enhancement: { level: 0, status: "ready", equipped: true, version: 1 },
  };
  const atBat = (index: number) => ({
    id: `consecutive-${index + 1}`,
    pitchSample: rounds[index]!.sample,
    batId: "wood",
    enhancementLevel: 0,
    powerRuleVersion: "sweetspot-v1",
    issuedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  const observations: unknown[] = [];
  try {
    await installBaseballDocument(page, server.baseUrl);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: baseballSession("synthetic-consecutive-rounds", "synthetic_agent") }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "synthetic_agent",
      sessionKey: "agent:synthetic_agent:main",
      featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
      methodResponses: {
        [BASEBALL_RPC.progress]: progress,
        [BASEBALL_RPC.leaderboard]: { distance: [], homeRunStreak: [] },
        [BASEBALL_RPC.beginAtBat]: atBat(0),
        [BASEBALL_RPC.plateAppearance]: { awardedGold: 0, progress },
      },
    });
    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    const host = page.locator("platformclaw-easter-egg");
    await host.waitFor({ state: "attached" });
    await page.locator("openclaw-app-topbar .topbar-brand").evaluate(async (element) => {
      for (let index = 0; index < 7; index++) {
        (element as HTMLElement).click();
        await new Promise((resolve) => {
          window.setTimeout(resolve, 25);
        });
      }
    });
    await page.locator('[data-game-choice="baseball"]').click();
    const game = host.locator('[role="application"]');
    const ball = game.locator(".platformclaw-easter-egg__projectile");
    for (const [index, round] of rounds.entries()) {
      await page.waitForFunction(
        (expected) => {
          const element = document.querySelector<HTMLElement>(
            'platformclaw-easter-egg [role="application"]',
          );
          return (
            element?.dataset.round === String(expected) && element.dataset.pitchState === "pitch"
          );
        },
        index + 1,
        { timeout: 15_000, polling: "raf" },
      );
      await gateway.deferNext(BASEBALL_RPC.plateAppearance);
      if (index + 1 < rounds.length) {
        await gateway.setMethodResponse(BASEBALL_RPC.beginAtBat, atBat(index + 1));
      }
      const before = await ball.boundingBox();
      await page.waitForTimeout(90);
      const after = await ball.boundingBox();
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      const movedPixels = Math.abs(after!.x - before!.x);
      expect(movedPixels).toBeGreaterThan(5);
      expect(await game.getAttribute("data-pitch-state")).toBe("pitch");
      if (round.key) {
        // Observe the rendered contact point; keep the real browser clock and RAF untouched.
        await page.waitForFunction(
          () => {
            const root = document.querySelector<HTMLElement>(
              'platformclaw-easter-egg [role="application"]',
            );
            if (root?.dataset.pitchState !== "pitch") {
              return false;
            }
            const projectile = root
              .querySelector(".platformclaw-easter-egg__projectile")!
              .getBoundingClientRect();
            const batter = root
              .querySelector(".platformclaw-easter-egg__player")!
              .getBoundingClientRect();
            return projectile.x + projectile.width / 2 <= batter.x + batter.width / 2 + 9;
          },
          undefined,
          { timeout: 3000, polling: "raf" },
        );
        await page.keyboard.press(round.key);
        await expect.poll(() => game.getAttribute("data-pitch-state")).toBe("in-play");
      }
      await expect
        .poll(async () => (await gateway.getRequests(BASEBALL_RPC.plateAppearance)).length, {
          timeout: 15_000,
        })
        .toBe(index + 1);
      const requests = await gateway.getRequests(BASEBALL_RPC.plateAppearance);
      const receipt = requests[index]!;
      expect(receipt.params.atBatId).toBe(atBat(index).id);
      if (round.key) {
        expect(typeof receipt.params.timingDeltaMs).toBe("number");
        expect(Math.abs(receipt.params.timingDeltaMs as number)).toBeLessThanOrEqual(100);
      } else {
        expect(receipt.params.timingDeltaMs).toBeNull();
      }
      expect(await game.getAttribute("data-pitch-state")).toBe("result");
      await expect
        .poll(() =>
          host.evaluate(
            (element) => (element as HTMLElement & { animationFrame: number }).animationFrame,
          ),
        )
        .toBe(0);
      observations.push({
        round: index + 1,
        kind: round.kind,
        key: round.key,
        before,
        after,
        movedPixels,
        request: receipt,
        result: await game.locator(".platformclaw-easter-egg__result").textContent(),
      });
      if (capture) {
        await page.screenshot({
          path: path.join(artifactDir, `round-${index + 1}-result.png`),
          fullPage: true,
        });
      }
      if (index + 1 === rounds.length) {
        await page.keyboard.press("Escape");
      }
      await gateway.resolveDeferred(BASEBALL_RPC.plateAppearance);
    }
    await page.waitForTimeout(800);
    expect(await gateway.getRequests(BASEBALL_RPC.beginAtBat)).toHaveLength(rounds.length);
    expect(await game.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    if (capture) {
      await writeFile(
        path.join(artifactDir, "observations.json"),
        JSON.stringify(
          {
            browserVersion: browser.version(),
            executablePath,
            realBrowserClock: true,
            noGameReopenOrRafMutation: true,
            observations,
            errors,
          },
          null,
          2,
        ),
      );
    }
    await context.close();
    await browser.close();
    await server.close();
  }
}, 90_000);
