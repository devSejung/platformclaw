import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import { BASEBALL_RPC } from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { requestBrowserFishing } from "../../../packages/platformclaw-control-plane/src/browser-gateway-fishing.ts";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import {
  FISHING_RPC,
  FISHING_RPC_METHODS,
} from "../../../packages/platformclaw-control-plane/src/fishing-contracts.ts";
import {
  getFishingSpecies,
  resolveFishingDifficulty,
} from "../../../packages/platformclaw-control-plane/src/fishing-economy.ts";
import {
  fishingFinishPosition,
  fishingHookQuality,
} from "../../../packages/platformclaw-control-plane/src/fishing-simulation.ts";
import { HORSE_RACING_RPC } from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import { SqliteControlPlaneStore } from "../../../packages/platformclaw-control-plane/src/sqlite-store.ts";
import { snapshot as racingSnapshot } from "../platformclaw/horse-racing.test-fixtures.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { baseballSession, installBaseballDocument } from "./platformclaw-baseball.e2e-helpers.ts";

const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.resolve(".artifacts/control-ui-e2e/platformclaw-fishing");

async function capture(page: Page, name: string): Promise<void> {
  if (captureProof) {
    await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
  }
}

async function observeFishingFrames(page: Page, durationMs: number) {
  return page
    .locator(".platformclaw-fishing canvas")
    .evaluate(async (canvas: HTMLCanvasElement, duration) => {
      const drawing = canvas.getContext("2d");
      if (!drawing) {
        throw new Error("Missing fishing drawing context");
      }
      const previous = Object.getOwnPropertyDescriptor(drawing, "clearRect");
      const clearRect: unknown = Reflect.get(drawing, "clearRect");
      if (typeof clearRect !== "function") {
        throw new Error("Missing canvas paint boundary");
      }
      const timestamps: number[] = [];
      Object.defineProperty(drawing, "clearRect", {
        configurable: true,
        writable: true,
        value: function (
          this: CanvasRenderingContext2D,
          x: number,
          y: number,
          width: number,
          height: number,
        ) {
          timestamps.push(performance.now());
          Reflect.apply(clearRect, this, [x, y, width, height]);
        },
      });
      const startedAt = performance.now();
      try {
        await new Promise((resolve) => window.setTimeout(resolve, duration));
      } finally {
        if (previous) {
          Object.defineProperty(drawing, "clearRect", previous);
        } else {
          Reflect.deleteProperty(drawing, "clearRect");
        }
      }
      // Lit updates can repaint inside a frame; count actual distinct paint times.
      const frames: number[] = [];
      for (const at of timestamps) {
        if (frames.length === 0 || at - frames.at(-1)! > 4) {
          frames.push(at);
        }
      }
      const intervals = frames
        .slice(1)
        .map((at, index) => at - frames[index]!)
        .toSorted((a, b) => a - b);
      const elapsedMs = performance.now() - startedAt;
      return {
        paints: timestamps.length,
        frames: frames.length,
        elapsedMs,
        observedFps: (frames.length * 1000) / elapsedMs,
        p50FrameMs: intervals.length ? intervals[Math.floor(intervals.length * 0.5)] : null,
        p95FrameMs: intervals.length ? intervals[Math.floor(intervals.length * 0.95)] : null,
      };
    }, durationMs);
}

async function openSelector(page: Page): Promise<void> {
  const mascot = page.locator(".about-hero__clawd");
  if (!(await mascot.isVisible())) {
    await page.locator(".sidebar-footer-bar__settings").first().click();
    await page.locator('.settings-sidebar__item[href$="/settings/about"]').click();
  }
  await mascot.waitFor({ state: "visible" });
  for (let index = 0; index < 7; index++) {
    await mascot.click();
    await page.waitForTimeout(25);
  }
  await page.locator('[data-game-choice="fishing"]').waitFor();
}

it("plays manual fishing through physical input, credits shared gold once, and preserves the existing arcade", async () => {
  if (captureProof) {
    await mkdir(artifactDir, { recursive: true });
  }
  const directory = await mkdtemp(path.join(tmpdir(), "platformclaw-fishing-browser-"));
  const store = new SqliteControlPlaneStore({
    databasePath: path.join(directory, "control.sqlite"),
    initialAdminAccountIds: ["synthetic.fisher"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  const { user } = await store.upsertPrincipal(
    {
      provider: "ldap",
      subject: "synthetic.fisher",
      accountId: "synthetic.fisher",
      employeeId: "TEST-FISHER",
      displayName: "테스트 낚시꾼",
    },
    Date.now(),
  );
  const initialGold = (await store.loadBaseballProgress(user.id)).gold;
  const server = await startControlUiE2eServer();
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  const browser = await chromium.launch({ executablePath, headless: !process.env.DISPLAY });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "ko-KR",
    serviceWorkers: "block",
    recordVideo: captureProof
      ? { dir: artifactDir, size: { width: 1280, height: 900 } }
      : undefined,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const rpcErrors: string[] = [];
  const observations: unknown[] = [];

  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await installBaseballDocument(page, server.baseUrl);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: baseballSession("synthetic.fisher", "synthetic_fisher") }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "synthetic_fisher",
      sessionKey: "agent:synthetic_fisher:main",
      featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
      deferredMethods: Array.from({ length: 128 }, () => FISHING_RPC_METHODS).flat(),
      methodResponses: {
        [BASEBALL_RPC.progress]: await store.loadBaseballProgress(user.id),
        [BASEBALL_RPC.leaderboard]: { distance: [], homeRunStreak: [] },
        [BASEBALL_RPC.beginAtBat]: {
          id: "sibling-at-bat",
          pitchSample: 0.2,
          batId: "wood",
          issuedAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
        [BASEBALL_RPC.plateAppearance]: {
          awardedGold: 0,
          progress: await store.loadBaseballProgress(user.id),
        },
        [HORSE_RACING_RPC.snapshot]: racingSnapshot(),
      },
    });
    await page.exposeFunction(
      "fishingProofRequest",
      (method: string, request: Record<string, unknown>) => {
        try {
          const response = requestBrowserFishing({
            store: store.fishing,
            userId: user.id,
            method,
            request,
            now: Date.now(),
          });
          if (!response.handled) {
            throw new Error(`Unrecognized fishing method ${method}`);
          }
          return { ok: true, payload: response.result };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          rpcErrors.push(message);
          return { ok: false, message };
        }
      },
    );
    // Only transport is mocked. Every fishing request runs the production parser,
    // SQLite owner and fixed-step simulation against the real clock and test account.
    const installFishingBridge = () => {
      type ProofWindow = Window & {
        fishingProofRequest: (
          method: string,
          params: Record<string, unknown>,
        ) => Promise<{ ok: boolean; payload?: unknown; message?: string }>;
        openclawControlUiE2eGateway: {
          resolveDeferred: (method: string, payload: unknown) => void;
          rejectDeferred: (method: string, error: { code: string; message: string }) => void;
        };
      };
      // Both globals are installed by the explicit test fixture before this bridge.
      const target = window as unknown as ProofWindow;
      const send: unknown = Object.getOwnPropertyDescriptor(WebSocket.prototype, "send")?.value;
      if (typeof send !== "function") {
        throw new Error("Missing browser socket send method");
      }
      WebSocket.prototype.send = function (data) {
        Reflect.apply(send, this, [data]);
        if (typeof data !== "string") {
          return;
        }
        const frame = JSON.parse(data) as { method?: string; params?: Record<string, unknown> };
        if (!frame.method?.startsWith("platformclaw.fishing.")) {
          return;
        }
        const method = frame.method;
        void target.fishingProofRequest(method, frame.params ?? {}).then((result) => {
          if (result.ok) {
            target.openclawControlUiE2eGateway.resolveDeferred(method, result.payload);
          } else {
            target.openclawControlUiE2eGateway.rejectDeferred(method, {
              code: "INVALID_REQUEST",
              message: result.message ?? "Fishing request failed",
            });
          }
        });
      };
    };
    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await page.evaluate(installFishingBridge);
    await openSelector(page);
    expect(await page.locator("[data-game-choice]").count()).toBe(3);
    await capture(page, "01-selector");
    await page.locator('[data-game-choice="fishing"]').click();
    const game = page.locator(".platformclaw-fishing");
    const cue = game.locator(".platformclaw-fishing__cue");
    const action = game.locator("[data-fishing-action]");
    await expect.poll(() => action.isEnabled()).toBe(true);
    expect(initialGold).toBe(0);
    expect(await game.locator("#fishing-panel").count()).toBe(0);
    expect(
      await game
        .getByRole("button", { name: /가방|도감|자동|장비|판매|강화|소리|동작|크게|작게/ })
        .count(),
    ).toBe(0);
    expect(await game.getByRole("combobox").count()).toBe(0);
    // Leave the settings takeover through its actual SPA back control.
    const exitSettings = page.getByRole("button", { name: "앱으로 돌아가기", exact: true });
    if (!(await exitSettings.isVisible())) {
      await page.getByRole("button", { name: "사이드바 펼치기", exact: true }).click();
    }
    await exitSettings.click();
    const composer = page.locator(".agent-chat__composer-shell").first();
    const draft = composer.locator("textarea").first();
    await composer.waitFor({ state: "visible" });
    const assertFixedDock = async () => {
      const bounds = await game.boundingBox();
      if (!bounds) throw new Error("Missing fishing overlay bounds");
      const viewport = page.viewportSize();
      if (!viewport) throw new Error("Missing browser viewport");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      expect(
        await game.evaluate((element) => {
          const style = getComputedStyle(element);
          return { position: style.position, right: style.right, bottom: style.bottom };
        }),
      ).toEqual({ position: "fixed", right: "24px", bottom: "24px" });
      return { bounds, viewport };
    };
    const initialFixedDock = await assertFixedDock();
    observations.push({ initialFixedDock });
    await draft.fill("입력 중에도 낚시는 채팅을 가로채지 않아요.\n".repeat(6));
    const expandedComposerFixedDock = await assertFixedDock();
    expect(Math.abs(expandedComposerFixedDock.bounds.x - initialFixedDock.bounds.x)).toBeLessThan(
      1,
    );
    expect(Math.abs(expandedComposerFixedDock.bounds.y - initialFixedDock.bounds.y)).toBeLessThan(
      1,
    );
    observations.push({ expandedComposerFixedDock });
    const beginsBeforeEditing = (await gateway.getRequests(FISHING_RPC.begin)).length;
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Space");
    await page.keyboard.press("Control");
    expect(await draft.inputValue()).toBe(" ");
    expect(await gateway.getRequests(FISHING_RPC.begin)).toHaveLength(beginsBeforeEditing);
    await draft.fill("");
    const opacity = game.locator('.platformclaw-fishing__opacity input[type="range"]');
    expect(await opacity.inputValue()).toBe("45");
    expect(await opacity.getAttribute("min")).toBe("10");
    expect(await opacity.getAttribute("max")).toBe("100");
    expect(await opacity.getAttribute("step")).toBe("5");
    await opacity.focus();
    await page.keyboard.press("End");
    await expect.poll(() => opacity.inputValue()).toBe("100");
    await expect
      .poll(() => game.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    await page.keyboard.press("Home");
    await expect.poll(() => opacity.inputValue()).toBe("10");
    await expect
      .poll(() => game.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("0.1");
    for (let step = 0; step < 7; step++) await page.keyboard.press("ArrowRight");
    await expect.poll(() => opacity.inputValue()).toBe("45");
    await expect
      .poll(() => game.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("0.45");
    expect(await game.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      "rgba(0, 0, 0, 0)",
    );
    await capture(page, "02-transparent-fixed-overlay");
    const canvasInk = await game.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
      const drawing = canvas.getContext("2d");
      if (!drawing) {
        throw new Error("Missing real 2D canvas");
      }
      const pixels = drawing.getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      let transparent = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] === 0) transparent++;
        if (
          pixels[index]! < 100 &&
          pixels[index + 1]! < 100 &&
          pixels[index + 2]! < 100 &&
          pixels[index + 3]! > 0
        ) {
          dark++;
        }
      }
      return { dark, transparent, area: canvas.width * canvas.height };
    });
    expect(canvasInk.dark).toBeGreaterThan(20);
    expect(canvasInk.dark / canvasInk.area).toBeLessThan(0.08);
    expect(canvasInk.transparent / canvasInk.area).toBeGreaterThan(0.9);
    const visibleCadence = await observeFishingFrames(page, 1100);
    expect(visibleCadence.frames).toBeGreaterThan(1);
    observations.push({ visibleCadence });
    // Exercise hit testing through the shared pointer-transparent arcade host;
    // programmatic focus/activation would miss clicks passing behind the dock.
    expect(await game.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("auto");
    await game.locator("canvas").click();
    await gateway.waitForRequest(FISHING_RPC.begin);
    const surface = game.locator("[data-fishing-surface]");
    expect(await surface.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.press("Space");
    expect(await surface.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await gateway.getRequests(FISHING_RPC.hook)).toHaveLength(0);
    await expect.poll(() => cue.textContent()).toContain("준비");
    const issued = store.fishing.loadFishingSnapshot(user.id, Date.now()).attempt!;
    for (const field of ["fishId", "fishLengthCm", "rarity"]) {
      expect(issued).not.toHaveProperty(field);
    }
    expect(issued.difficulty).toBeNull();
    await page.waitForTimeout(650);
    await capture(page, "03-casting");
    await expect.poll(() => cue.textContent()).toContain("입질을 기다려요.");
    await capture(page, "04-splash-and-wait");
    expect(issued.nibbles.length).toBeLessThanOrEqual(5);
    for (const nibble of issued.nibbles) {
      expect(nibble.at + nibble.durationMs).toBeLessThan(issued.biteAt);
    }
    const nibble = issued.nibbles[0];
    if (nibble) {
      await page.waitForTimeout(Math.max(0, nibble.at + 10 - Date.now()));
      await expect.poll(() => cue.textContent()).toContain("아직이에요");
      expect(await game.locator("[data-fishing-bite]").count()).toBe(0);
      await capture(page, "05-random-nibble");
    }
    observations.push({ nibbles: issued.nibbles });
    await page.waitForTimeout(Math.max(0, issued.biteAt - Date.now() + 10));
    // Observe the hook RPC before keyup: Control acts immediately on keydown.
    await page.keyboard.down("Control");
    await gateway.waitForRequest(FISHING_RPC.hook);
    await expect.poll(() => game.locator("meter").count()).toBe(1);
    const hooked = store.fishing.loadFishingSnapshot(user.id, Date.now()).attempt!;
    for (const field of ["fishId", "fishLengthCm", "rarity"]) {
      expect(hooked).not.toHaveProperty(field);
    }
    expect(hooked.difficulty).toBeGreaterThanOrEqual(1);
    expect(hooked.difficulty).toBeLessThanOrEqual(10);
    if (hooked.hookedAt === null) throw new Error("Missing server hook timestamp");
    expect(hooked.quality).toBe(fishingHookQuality(hooked.hookedAt - issued.biteAt));
    expect(hooked.quality).not.toBeNull();
    expect(await game.locator(".platformclaw-fishing__tension").count()).toBe(1);
    // A real quick release/press must not leave a rejected held edge on the server.
    // Do not sleep around the producer's timestamp boundary to make this pass.
    await page.keyboard.up("Control");
    await page.keyboard.down("Control");
    await expect.poll(() => cue.textContent()).toContain(`${hooked.quality}!`);
    const fightCue = await cue.textContent();
    expect(fightCue).not.toContain("난이도");
    observations.push({ hooked });
    await capture(page, "06-hook-judgment");
    let held = true;
    for (let sample = 0; sample < 80; sample++) {
      if (await game.locator("[data-fishing-finish]").count()) {
        break;
      }
      const tension = await game
        .locator("meter")
        .evaluateAll((meters) => (meters[0] as HTMLMeterElement | undefined)?.value ?? null);
      if (tension === null) {
        break;
      }
      if (held && tension > 0.68) {
        await page.keyboard.up("Control");
        held = false;
      } else if (!held && tension < 0.35) {
        await page.keyboard.down("Control");
        held = true;
      }
      if (sample === 10) {
        await capture(page, "07-fighting");
      }
      await page.waitForTimeout(100);
    }
    await page.keyboard.up("Control");
    await expect.poll(() => game.locator("[data-fishing-finish]").count()).toBe(1);
    const finishing = store.fishing.loadFishingSnapshot(user.id, Date.now());
    expect(finishing.attempt?.phase).toBe("finishing");
    for (const field of ["fishId", "fishLengthCm", "rarity"]) {
      expect(finishing.attempt).not.toHaveProperty(field);
    }
    expect(finishing.gold).toBe(initialGold);
    expect(finishing.totalCaught).toBe(0);
    const finish = finishing.attempt!;
    if (finish.finishStartedAt === null || finish.finishDeadlineAt === null)
      throw new Error("Missing server finish window");
    const cursor = game.locator("[data-fishing-finish-cursor]");
    const cursorBefore = await cursor.getAttribute("style");
    await page.waitForTimeout(60);
    expect(await cursor.getAttribute("style")).not.toBe(cursorBefore);
    await capture(page, "08a-finishing-unpaid");
    // Use the shared seed/time rule to aim a real physical press, never a finish RPC fixture.
    let targetAt: number | null = null;
    for (let at = Date.now() + 180; at < finish.finishDeadlineAt - 100; at++) {
      if (Math.abs(fishingFinishPosition(finish.seed, at - finish.finishStartedAt) - 0.5) < 0.001) {
        targetAt = at;
        break;
      }
    }
    if (targetAt === null) throw new Error("No center crossing remains in the real finish window");
    await page.waitForTimeout(Math.max(0, targetAt - Date.now()));
    await page.keyboard.down("Control");
    await gateway.waitForRequest(FISHING_RPC.finish);
    await page.keyboard.up("Control");
    await expect.poll(() => game.locator("[data-fishing-catch]").count()).toBe(1);
    await capture(page, "08-landed");
    const caught = store.fishing.loadFishingSnapshot(user.id, Date.now());
    expect(caught.totalCaught).toBe(1);
    const fish = caught.attempt?.result;
    expect(fish).not.toBeNull();
    if (!fish) throw new Error("Missing completed server catch");
    expect(fish.lengthCm).toBeGreaterThan(0);
    expect(caught.gold).toBe(initialGold + fish.rewardGold);
    expect(caught.totalEarnedGold).toBe(fish.rewardGold);
    expect(fish.accuracy).toBeGreaterThan(0.85);
    expect(fish.bonusMultiplier).toBeCloseTo(1 + fish.accuracy);
    expect(caught.bestCatch?.fishId).toBe(fish.fishId);
    expect(hooked.difficulty).toBe(resolveFishingDifficulty(fish.fishId, fish.lengthCm));
    expect(fightCue).not.toContain(getFishingSpecies(fish.fishId).nameKo);
    expect((await store.loadBaseballProgress(user.id)).gold).toBe(caught.gold);
    const reeling = await gateway.getRequests(FISHING_RPC.reel);
    expect(reeling.some((request) => (request.params as { held: boolean }).held)).toBe(true);
    expect(reeling.some((request) => !(request.params as { held: boolean }).held)).toBe(true);
    // Repeat an actual accepted terminal request; the ledger effect stays singular.
    const finished = await gateway.getRequests(FISHING_RPC.finish);
    const terminal = finished.at(-1);
    if (!terminal) throw new Error("No recorded fight/settlement request");
    requestBrowserFishing({
      store: store.fishing,
      userId: user.id,
      method: terminal.method,
      request: terminal.params as Record<string, unknown>,
      now: Date.now(),
    });
    expect((await store.loadBaseballProgress(user.id)).gold).toBe(caught.gold);
    const ledger = new DatabaseSync(path.join(directory, "control.sqlite"), { readOnly: true });
    try {
      // Read-only proof at the canonical wallet boundary, without reaching into private store state.
      const movements = ledger
        .prepare(
          "SELECT reference_id, delta FROM game_gold_transactions WHERE user_id = ? AND reason = 'fishing_catch'",
        )
        .all(user.id);
      expect(movements).toEqual([{ reference_id: fish.id, delta: fish.rewardGold }]);
    } finally {
      ledger.close();
    }
    await expect.poll(() => action.isEnabled()).toBe(true);
    await game.getByRole("button", { name: "랭킹", exact: true }).click();
    await expect
      .poll(() => game.locator("#fishing-panel").textContent())
      .toContain("테스트 낚시꾼");
    await capture(page, "09-ranking");
    await game.getByRole("button", { name: "랭킹", exact: true }).click();
    expect(await game.locator("#fishing-panel").count()).toBe(0);
    await game.getByRole("button", { name: "기록", exact: true }).click();
    await expect
      .poll(() => game.locator("#fishing-panel").textContent())
      .toContain(getFishingSpecies(fish.fishId).nameKo);
    await capture(page, "10-records");
    await game.getByRole("button", { name: "기록", exact: true }).click();
    expect(await game.locator("#fishing-panel").count()).toBe(0);
    // A second won fight intentionally receives no finishing input: timeout pays baseline once.
    await game.locator("canvas").click();
    await expect.poll(async () => (await gateway.getRequests(FISHING_RPC.begin)).length).toBe(2);
    const second = store.fishing.loadFishingSnapshot(user.id, Date.now()).attempt!;
    await page.waitForTimeout(Math.max(0, second.biteAt - Date.now() + 10));
    await page.keyboard.down("Control");
    await expect.poll(() => game.locator("meter").count()).toBe(1);
    let secondHeld = true;
    for (let sample = 0; sample < 80; sample++) {
      if (await game.locator("[data-fishing-finish]").count()) break;
      const tension = await game
        .locator("meter")
        .evaluateAll((meters) => (meters[0] as HTMLMeterElement | undefined)?.value ?? null);
      if (tension === null) break;
      if (secondHeld && tension > 0.68) {
        await page.keyboard.up("Control");
        secondHeld = false;
      } else if (!secondHeld && tension < 0.35) {
        await page.keyboard.down("Control");
        secondHeld = true;
      }
      await page.waitForTimeout(100);
    }
    await page.keyboard.up("Control");
    await expect.poll(() => game.locator("[data-fishing-finish]").count()).toBe(1);
    const timeoutPending = store.fishing.loadFishingSnapshot(user.id, Date.now());
    expect(timeoutPending.gold).toBe(caught.gold);
    const deadline = timeoutPending.attempt?.finishDeadlineAt;
    if (deadline === null || deadline === undefined)
      throw new Error("Missing timeout finish deadline");
    const finishesBeforeTimeout = (await gateway.getRequests(FISHING_RPC.finish)).length;
    await page.waitForTimeout(Math.max(0, deadline - Date.now() + 100));
    await expect.poll(() => game.locator("[data-fishing-catch]").count()).toBe(1);
    const timedOut = store.fishing.loadFishingSnapshot(user.id, Date.now());
    const timeoutFish = timedOut.attempt?.result;
    if (!timeoutFish) throw new Error("Missing baseline catch after finish timeout");
    expect(timeoutFish.accuracy).toBe(0);
    expect(timeoutFish.bonusMultiplier).toBe(1);
    expect(timedOut.totalCaught).toBe(2);
    expect(timedOut.gold).toBe(caught.gold + timeoutFish.rewardGold);
    expect(timedOut.totalEarnedGold).toBe(fish.rewardGold + timeoutFish.rewardGold);
    expect((await store.loadBaseballProgress(user.id)).gold).toBe(timedOut.gold);
    expect(await gateway.getRequests(FISHING_RPC.finish)).toHaveLength(finishesBeforeTimeout);
    await capture(page, "11-finish-timeout-baseline");
    observations.push({ finishing, finishTargetAt: targetAt, timedOut });

    await page.setViewportSize({ width: 320, height: 740 });
    await assertFixedDock();
    await game.getByRole("button", { name: "기록", exact: true }).click();
    const bounds = await game.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    await capture(page, "14-widget-320");
    await page.evaluate(() => {
      document.body.style.zoom = "1.25";
    });
    await assertFixedDock();
    await capture(page, "15-zoom-125");
    await page.setViewportSize({ width: 320, height: 320 });
    await assertFixedDock();
    await capture(page, "15b-zoom-125-short-viewport");
    await page.evaluate(() => {
      document.body.style.zoom = "";
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await game.getByRole("button", { name: "기록", exact: true }).click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await capture(page, "16-reduced-motion");
    // Xvfb's real browser tabs provide actual visibility transitions. Headless
    // runs still exercise gameplay; captured Linux proof uses DISPLAY/Xvfb.
    if (process.env.DISPLAY) {
      const backgroundTab = await context.newPage();
      await backgroundTab.goto("about:blank");
      await backgroundTab.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hidden)).toBe(true);
      const hiddenCadence = await observeFishingFrames(page, 1100);
      expect(hiddenCadence.paints).toBe(0);
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hidden)).toBe(false);
      const resumedCadence = await observeFishingFrames(page, 1100);
      expect(resumedCadence.frames).toBeGreaterThan(1);
      observations.push({ hiddenCadence, resumedCadence, realTabVisibility: true });
      await capture(page, "16b-tab-return");
      await backgroundTab.close();
    }
    await game.getByRole("button", { name: "게임 선택", exact: true }).click();
    expect(await page.locator("platformclaw-fishing").count()).toBe(0);
    await gateway.setMethodResponse(
      BASEBALL_RPC.progress,
      await store.loadBaseballProgress(user.id),
    );
    await page.locator('[data-game-choice="baseball"]').click();
    await page.locator('platformclaw-easter-egg [role="application"]').waitFor();
    await expect
      .poll(() => page.locator(".platformclaw-easter-egg__hud").textContent())
      .toContain(`골드 ${timedOut.gold}`);
    await capture(page, "17-baseball-regression");
    await page
      .getByRole("navigation")
      .filter({ has: page.getByRole("button", { name: "게임 선택", exact: true }) })
      .getByRole("button", { name: "게임 선택", exact: true })
      .click();
    await page.locator('[data-game-choice="racing"]').click();
    await page.locator("platformclaw-horse-racing").waitFor();
    await capture(page, "18-racing-regression");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator("platformclaw-horse-racing").count()).toBe(0);
    await openSelector(page);
    await page.locator('[data-game-choice="fishing"]').click();
    await expect.poll(() => action.isEnabled()).toBe(true);
    const restored = store.fishing.loadFishingSnapshot(user.id, Date.now());
    expect(restored.totalCaught).toBe(2);
    expect((await store.loadBaseballProgress(user.id)).gold).toBe(timedOut.gold);
    await game.getByRole("button", { name: "기록", exact: true }).click();
    await expect
      .poll(() => game.locator("#fishing-panel").textContent())
      .toContain(getFishingSpecies(restored.bestCatch!.fishId).nameKo);
    await game.getByRole("button", { name: "기록", exact: true }).click();
    await game.locator("canvas").click();
    await expect.poll(async () => (await gateway.getRequests(FISHING_RPC.begin)).length).toBe(3);
    await page.waitForTimeout(2600);
    await page.keyboard.press("Space");

    await expect.poll(() => cue.textContent()).toContain("놓쳤어요.");
    await capture(page, "19-early-hook-miss");
    const missed = store.fishing.loadFishingSnapshot(user.id, Date.now()).attempt!;
    await page.keyboard.down("Control");
    await expect.poll(async () => (await gateway.getRequests(FISHING_RPC.begin)).length).toBe(4);
    // Keydown already cast: a later chord cannot retroactively cancel that action.
    await page.keyboard.press("c");
    await page.keyboard.up("Control");
    expect(await gateway.getRequests(FISHING_RPC.begin)).toHaveLength(4);
    const recast = store.fishing.loadFishingSnapshot(user.id, Date.now()).attempt!;
    expect(recast.id).not.toBe(missed.id);
    expect(recast.issuedAt - missed.issuedAt).toBeLessThan(23_000);
    expect((await store.loadBaseballProgress(user.id)).gold).toBe(timedOut.gold);
    await capture(page, "20-immediate-ctrl-recast");
    // Keep holding through the genuine fight: breaking the line must remain a loss.
    await page.waitForTimeout(Math.max(0, recast.biteAt - Date.now() + 10));
    const biteMark = game.locator("[data-fishing-bite]");
    await expect.poll(() => biteMark.isVisible()).toBe(true);
    expect((await biteMark.textContent())?.trim()).toBe("!");
    expect(await biteMark.evaluate((element) => getComputedStyle(element).fontSize)).toBe("28px");
    await capture(page, "21a-genuine-bite-exclamation");
    await page.keyboard.down("Control");
    await expect.poll(() => game.locator("meter").count()).toBe(1);
    const tensionReadout = game.locator(".platformclaw-fishing__tension");
    await expect.poll(() => tensionReadout.getAttribute("data-danger")).toBe("high");
    expect(await tensionReadout.textContent()).toMatch(/\d+%/);
    await capture(page, "21b-tension-danger");
    await expect.poll(() => game.locator("meter").count()).toBe(0);
    await page.keyboard.up("Control");
    const broken = store.fishing.loadFishingSnapshot(user.id, Date.now());
    expect(broken.attempt?.phase).toBe("escaped");
    expect(broken.attempt?.fight?.escapeReason).toBe("line_broken");
    expect(broken.attempt?.result).toBeNull();
    expect(broken.gold).toBe(timedOut.gold);
    expect(broken.totalCaught).toBe(2);
    await expect.poll(() => cue.textContent()).toContain("줄이 끊어졌어요.");
    observations.push({ broken });
    await capture(page, "21-line-broken-no-reward");
    await page.keyboard.press("Escape");
    expect(await page.locator("platformclaw-fishing").count()).toBe(0);
    const snapshotsAfterClose = (await gateway.getRequests(FISHING_RPC.snapshot)).length;
    await page.waitForTimeout(1150);
    expect(await gateway.getRequests(FISHING_RPC.snapshot)).toHaveLength(snapshotsAfterClose);
    expect(errors).toEqual([]);
    expect(rpcErrors).toEqual([]);
    observations.push({
      initialGold,
      caught,
      reeling,
      final: store.fishing.loadFishingSnapshot(user.id, Date.now()),
      browserVersion: browser.version(),
      clock: "real",
      transport: "mock Gateway, production fishing parser and SQLite owner",
    });
  } catch (error) {
    observations.push({
      failure: error instanceof Error ? error.message : String(error),
      currentSnapshot: store.fishing.loadFishingSnapshot(user.id, Date.now()),
      activeElement: await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        className: document.activeElement?.className,
        hasFocus: document.hasFocus(),
      })),
    });
    await capture(page, "99-failure");
    throw error;
  } finally {
    if (captureProof) {
      await writeFile(
        path.join(artifactDir, "observations.json"),
        JSON.stringify({ observations, errors, rpcErrors }, null, 2),
      );
    }
    await context.close();
    await browser.close();
    await server.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
