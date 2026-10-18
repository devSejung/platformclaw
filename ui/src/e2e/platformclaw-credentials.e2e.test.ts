import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeBrowser = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "platformclaw-credentials",
);
let browser: Browser;
let server: ControlUiE2eServer;

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    path: path.join(proofDir, name),
    fullPage: true,
    animations: "disabled",
  });
}

describeBrowser("PlatformClaw credentials in the Settings application", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps edits through sibling saves and follows the real light, dark, and mobile settings", async () => {
    const context = await browser.newContext({
      locale: "ko-KR",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      const response = await page.request.get(server.baseUrl);
      const source = await response.text();
      await page.route("**/platformclaw/app/**", (route) =>
        route.fulfill({
          status: response.status(),
          headers: response.headers(),
          body: source.replace(
            "</head>",
            `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'></head>`,
          ),
        }),
      );
      await page.route("**/platformclaw/api/auth/session", (route) =>
        route.fulfill({
          json: {
            authenticated: true,
            user: {
              accountId: "person.one",
              displayName: "Person One",
              department: "Platform Lab",
              globalRole: "member",
            },
            agent: { agentId: "person_one", state: "active" },
            session: {
              idleExpiresAt: Date.now() + 60_000,
              absoluteExpiresAt: Date.now() + 120_000,
            },
          },
        }),
      );
      await page.route("**/platformclaw/api/announcements", (route) =>
        route.fulfill({
          json: {
            revision: 0,
            serverNow: Date.now(),
            announcement: null,
          },
        }),
      );
      const configured = new Set<string>();
      const submitted: Array<{ envName: string; value?: string }> = [];
      let rejectSave = false;
      let resolveSave!: () => void;
      const pendingSave = new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
      await page.route("**/platformclaw/api/exec-credentials", async (route) => {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON() as { envName: string; value?: string };
          submitted.push(body);
          if (rejectSave) {
            await route.fulfill({ status: 503, json: { error: "잠시 후 다시 시도하세요." } });
            return;
          }
          if (body.envName === "GITHUB_TOKEN") {
            await pendingSave;
          }
          configured.add(body.envName);
          await route.fulfill({ json: { envName: body.envName, revision: 1 } });
          return;
        }
        await route.fulfill({
          json: {
            definitions: ["GITHUB_TOKEN", "JIRA_API_TOKEN"].map((envName) => ({
              envName,
              configured: configured.has(envName),
            })),
          },
        });
      });
      await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: "person_one",
        sessionKey: "agent:person_one:main",
        featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
        operatorScopes: ["operator.read", "operator.write"],
      });

      await page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`);
      const sidebar = page.locator(".settings-sidebar");
      await sidebar.getByRole("link", { name: "인증정보", exact: true }).click();
      const settings = page.locator("platformclaw-exec-credentials");
      await settings.getByRole("heading", { name: "개인 인증정보" }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/platformclaw/app/settings/credentials");
      expect(await page.locator("html").getAttribute("data-theme")).toBe("platformclaw-light");
      expect(
        await settings
          .locator(".settings-group")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe("rgb(239, 233, 222)");
      const first = settings.getByLabel("GITHUB_TOKEN", { exact: true });
      const second = settings.getByLabel("JIRA_API_TOKEN", { exact: true });
      const firstSave = settings.locator("[data-action='save'][data-env='GITHUB_TOKEN']");
      const secondSave = settings.locator("[data-action='save'][data-env='JIRA_API_TOKEN']");
      expect(await firstSave.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        "rgb(15, 124, 114)",
      );
      await first.fill("fixture-github-token");
      await second.fill("fixture-jira-token");
      await firstSave.click();
      await second.press("Home");
      await second.press("ArrowRight");
      resolveSave();
      await expect.poll(() => first.getAttribute("placeholder")).toBe("••••••••");
      expect(
        await second.evaluate((element: HTMLInputElement) => ({
          focused: document.activeElement === element,
          caret: element.selectionStart,
        })),
      ).toEqual({ focused: true, caret: 1 });
      await second.press("X");
      expect(await second.inputValue()).toBe("fXixture-jira-token");
      expect(await first.inputValue()).toBe("");
      expect(await firstSave.isDisabled()).toBe(true);
      await capture(page, "01-credentials-light.png");

      rejectSave = true;
      await secondSave.click();
      await settings.getByRole("status").filter({ hasText: "잠시 후 다시 시도하세요." }).waitFor();
      expect(await second.inputValue()).toBe("fXixture-jira-token");
      rejectSave = false;
      await second.press("Enter");
      await expect.poll(() => second.getAttribute("placeholder")).toBe("••••••••");
      expect(await second.inputValue()).toBe("");
      expect(submitted.map((body) => body.value)).toEqual([
        "fixture-github-token",
        "fXixture-jira-token",
        "fXixture-jira-token",
      ]);

      await page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`);
      await page.locator("wa-radio[value='dark']").click();
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("platformclaw");
      await sidebar.getByRole("link", { name: "인증정보", exact: true }).click();
      await settings.getByLabel("GITHUB_TOKEN", { exact: true }).waitFor();
      await capture(page, "02-credentials-dark.png");

      await page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`);
      await page.locator("wa-radio[value='light']").click();
      await sidebar.getByRole("link", { name: "인증정보", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await settings.getByLabel("GITHUB_TOKEN", { exact: true }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(await settings.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        false,
      );
      await capture(page, "03-credentials-mobile.png");
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
