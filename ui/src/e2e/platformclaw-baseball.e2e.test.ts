import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BASEBALL_RPC,
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
  revision: 0,
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
        `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'></head>`,
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

async function newAccountPage(
  accountId: string,
  agentId: string,
  methodResponses: Record<string, unknown>,
) {
  const context = await browser.newContext({
    locale: "ko-KR",
    serviceWorkers: "block",
    viewport: { height: 900, width: 760 },
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
    const accountA = await newAccountPage("person.a", "person_a", {
      [BASEBALL_RPC.progress]: { sequence: [initialA, equippedA] },
      [BASEBALL_RPC.purchaseBat]: {
        batId: "silver",
        price: 50,
        purchased: true,
        progress: purchasedA,
      },
      [BASEBALL_RPC.equipBat]: { batId: "silver", changed: true, progress: equippedA },
    });

    await openGame(accountA.page);
    expect((await accountA.gateway.waitForRequest(BASEBALL_RPC.progress)).params).toEqual({});
    const game = accountA.page.locator('platformclaw-easter-egg [role="application"]');
    await expect.poll(() => game.getByText("골드 50", { exact: true }).isVisible()).toBe(true);
    await game.getByRole("button", { name: "나무 배트 · 상점" }).click();

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
    const reopened = accountA.page.locator('platformclaw-easter-egg [role="application"]');
    await expect
      .poll(() => reopened.getByRole("button", { name: "실버 배트 · 상점" }).isVisible())
      .toBe(true);
    await expect
      .poll(() => reopened.getByText("최고 138m", { exact: true }).isVisible())
      .toBe(true);
    await capture(accountA.page, "02-restored-account-a.png");

    const accountB = await newAccountPage("person.b", "person_b", {
      [BASEBALL_RPC.progress]: progress(),
    });
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
});
