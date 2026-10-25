import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
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
import { installCredentialApi } from "./platformclaw-credentials.test-support.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeBrowser = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "platformclaw-credentials",
);
let browser: Browser;
let server: ControlUiE2eServer;

async function context(locale = "en-US"): Promise<BrowserContext> {
  return browser.newContext({
    locale,
    serviceWorkers: "block",
    viewport: { width: 1920, height: 1080 },
    ...(captureProof
      ? { recordVideo: { dir: path.join(proofDir, "videos"), size: { width: 1280, height: 720 } } }
      : {}),
  });
}

async function capture(page: Page, name: string): Promise<void> {
  if (captureProof) {
    await mkdir(proofDir, { recursive: true });
    await page.screenshot({
      path: path.join(proofDir, name),
      fullPage: true,
      animations: "disabled",
    });
  }
}

async function closeContext(current: BrowserContext, page: Page, name: string): Promise<void> {
  const video = page.video();
  await current.close();
  if (captureProof && video) {
    await video.saveAs(path.join(proofDir, name));
  }
}

async function openCredentials(page: Page, keys: string[], admin = false) {
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
          globalRole: admin ? "admin" : "member",
        },
        agent: { agentId: "person_one", state: "active" },
        session: { idleExpiresAt: Date.now() + 60_000, absoluteExpiresAt: Date.now() + 120_000 },
      },
    }),
  );
  await page.route("**/platformclaw/api/announcements", (route) =>
    route.fulfill({ json: { revision: 0, serverNow: Date.now(), announcement: null } }),
  );
  const api = await installCredentialApi(page, { accountId: "person.one", keys });
  const gateway = await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: "person_one",
    sessionKey: "agent:person_one:main",
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    operatorScopes: ["operator.read", "operator.write"],
  });
  await page.goto(`${server.baseUrl}platformclaw/app/settings/credentials`);
  const component = page.locator("platformclaw-exec-credentials");
  await component.locator("[data-action='select']:visible").first().waitFor();
  return { component, api, gateway };
}

async function selectKey(component: Locator, envName: string, admin = false): Promise<Locator> {
  const search = component.locator("input[name='credentialSearch']:visible");
  if (!(await search.isVisible())) {
    await component.locator("[data-action='picker']").click();
  }
  await search.fill(envName);
  await component.locator(`[data-action='select'][data-env='${envName}']:visible`).click();
  const editor = component.locator(
    `[${admin ? "data-admin-editor" : "data-editor"}='${envName}']:visible`,
  );
  await editor.waitFor();
  return editor;
}

async function noOverflow(page: Page, component: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(await component.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
    false,
  );
}

describeBrowser("PlatformClaw credentials in the Settings application", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("browses 32 keys and preserves drafts through selection, filtering, failures, and conflicts", async () => {
    const current = await context();
    const page = await current.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      const keys = [
        "GITHUB_TOKEN",
        "JIRA_API_TOKEN",
        ...Array.from(
          { length: 30 },
          (_, index) => `SERVICE_${String(index).padStart(2, "0")}_TOKEN`,
        ),
      ];
      const { component, api, gateway } = await openCredentials(page, keys);
      const rows = component.locator("[data-action='select']:visible");
      await expect.poll(() => rows.count()).toBe(8);
      const firstRow = await rows.first().boundingBox();
      const firstEditor = await component.locator("[data-editor]:visible").boundingBox();
      expect(firstRow!.x + firstRow!.width).toBeLessThanOrEqual(firstEditor!.x);
      await capture(page, "01-credentials-fhd-32.png");
      await component.locator("[data-action='next']").click();
      expect(await rows.first().getAttribute("data-env")).not.toBe("GITHUB_TOKEN");
      await component.locator("[data-action='previous']").click();

      const github = await selectKey(component, "GITHUB_TOKEN");
      await github.getByLabel("GITHUB_TOKEN", { exact: true }).fill("fixture-github-draft");
      const jira = await selectKey(component, "JIRA_API_TOKEN");
      const jiraInput = jira.getByLabel("JIRA_API_TOKEN", { exact: true });
      await jiraInput.fill("fixture-jira-draft");
      await component.locator("input[name='credentialSearch']:visible").fill("");
      await component.locator("select[name='credentialStatus']:visible").selectOption("drafts");
      await expect.poll(() => rows.count()).toBe(2);
      await capture(page, "02-credentials-drafts.png");
      await selectKey(component, "GITHUB_TOKEN");
      expect(await github.getByLabel("GITHUB_TOKEN", { exact: true }).inputValue()).toBe(
        "fixture-github-draft",
      );
      await github.locator("[data-action='save']").click();
      await expect
        .poll(() => github.getByLabel("GITHUB_TOKEN", { exact: true }).inputValue())
        .toBe("");
      expect(await github.isVisible()).toBe(true);
      expect(api.submissions[0]).toMatchObject({
        expectedAccountId: "person.one",
        expectedDefinitionToken: "definition-1",
        expectedCredentialToken: null,
      });

      await component.locator("select[name='credentialStatus']:visible").selectOption("missing");
      await selectKey(component, "JIRA_API_TOKEN");
      expect(await jiraInput.inputValue()).toBe("fixture-jira-draft");
      api.failNextSave();
      await jira.locator("[data-action='save']").click();
      await jira.getByText("Credential request failed.", { exact: true }).waitFor();
      expect(await jiraInput.inputValue()).toBe("fixture-jira-draft");
      await jiraInput.press("Enter");
      await expect.poll(() => jiraInput.inputValue()).toBe("");
      expect(await jira.isVisible()).toBe(true);

      await jiraInput.fill("fixture-stale-private-draft");
      const updatedElsewhere = api.replaceExternally("JIRA_API_TOKEN");
      await jira.locator("[data-action='save']").click();
      const reload = jira.locator("[data-action='reload']");
      await jira.getByRole("alert").filter({ hasText: "This key changed elsewhere." }).waitFor();
      expect(await jiraInput.inputValue()).toBe("fixture-stale-private-draft");
      await capture(page, "03-credentials-conflict.png");
      await reload.click();
      await expect.poll(() => jiraInput.inputValue()).toBe("");
      await jiraInput.fill("fixture-reviewed-replacement");
      await jira.locator("[data-action='save']").click();
      await expect.poll(() => jiraInput.inputValue()).toBe("");
      expect(api.submissions.at(-1)?.expectedCredentialToken).toBe(
        updatedElsewhere.credentialToken,
      );
      expect(await jiraInput.getAttribute("type")).toBe("password");
      expect(await component.textContent()).not.toContain("fixture-reviewed-replacement");
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      await capture(page, "04-credentials-saved.png");
      expect(pageErrors).toEqual([]);
    } finally {
      await closeContext(current, page, "credentials-workspace-flow.webm");
    }
  });

  it("follows the real themes and keeps long key names usable in small, mobile, and enlarged layouts", async () => {
    const current = await context("ko-KR");
    const page = await current.newPage();
    try {
      const longKey = `TOKEN_${"A".repeat(122)}`;
      const { component } = await openCredentials(page, ["GITHUB_TOKEN", longKey]);
      expect(await page.locator("html").getAttribute("data-theme")).toBe("platformclaw-light");
      const save = component.locator("[data-action='save'][data-env='GITHUB_TOKEN']");
      expect(await save.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        "rgb(15, 124, 114)",
      );
      await capture(page, "05-credentials-light-fhd.png");
      await page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`);
      await page.locator("wa-radio[value='dark']").click();
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("platformclaw");
      await page
        .locator(".settings-sidebar")
        .getByRole("link", { name: "인증정보", exact: true })
        .click();
      await component.locator("[data-action='select']:visible").first().waitFor();
      await capture(page, "06-credentials-dark-fhd.png");
      for (const size of [
        { width: 1280, height: 800 },
        { width: 800, height: 700 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        if (size.width <= 800) {
          await selectKey(component, longKey);
          await component.getByLabel(longKey, { exact: true }).fill("fixture-long-key-draft");
          await selectKey(component, "GITHUB_TOKEN");
          await selectKey(component, longKey);
          expect(await component.getByLabel(longKey, { exact: true }).inputValue()).toBe(
            "fixture-long-key-draft",
          );
        }
        await noOverflow(page, component);
        await capture(page, `07-credentials-${size.width}.png`);
      }
      await page.setViewportSize({ width: 800, height: 700 });
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      await noOverflow(page, component);
      expect(await component.getByLabel(longKey, { exact: true }).isVisible()).toBe(true);
      await capture(page, "08-credentials-200-percent-css-zoom.png");
    } finally {
      await closeContext(current, page, "credentials-responsive-themes.webm");
    }
  });

  it("separates allowed-key administration, preserves personal drafts, and confirms destructive removal", async () => {
    const current = await context();
    const page = await current.newPage();
    try {
      const { component, api } = await openCredentials(
        page,
        ["GITHUB_TOKEN", "JIRA_API_TOKEN"],
        true,
      );
      const github = await selectKey(component, "GITHUB_TOKEN");
      await github.getByLabel("GITHUB_TOKEN", { exact: true }).fill("fixture-admin-personal-draft");
      const personalTab = component.getByRole("tab", { name: "My credentials", exact: true });
      const administrationTab = component.getByRole("tab", { name: "Allowed keys", exact: true });
      await administrationTab.click();
      await component.locator("[data-action='add-definition']:visible").click();
      const form = component.locator("[data-admin-form]");
      await form.locator("input[name='envName']").fill("REPORT_TOKEN");
      await form.locator("button").click();
      await expect
        .poll(() => api.snapshot().definitions.some((item) => item.envName === "REPORT_TOKEN"))
        .toBe(true);
      await selectKey(component, "REPORT_TOKEN", true);
      const remove = component.locator(
        "[data-action='remove-definition'][data-env='REPORT_TOKEN']:visible",
      );
      const beforeRemoval = api.submissions.length;
      await remove.click();
      const dialog = page.getByRole("dialog", { name: "Remove allowed key", exact: true });
      const modal = page.locator("openclaw-modal-dialog.credential-confirmation");
      await dialog.waitFor();
      expect(await modal.textContent()).toMatch(/all users|every user|every employee/i);
      expect(api.submissions).toHaveLength(beforeRemoval);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(api.submissions).toHaveLength(beforeRemoval);
      await remove.click();
      await dialog.waitFor();
      await capture(page, "09-credentials-admin-remove-confirmation.png");
      await modal.locator("[data-action='confirm-remove-definition']").click();
      await expect
        .poll(() => api.snapshot().definitions.some((item) => item.envName === "REPORT_TOKEN"))
        .toBe(false);
      // The response precedes modal teardown and its return-focus restoration.
      // Wait until the page is interactive before exercising tab navigation.
      await modal.waitFor({ state: "detached" });
      await administrationTab.focus();
      await expect
        .poll(() => administrationTab.evaluate((tab) => tab.matches(":focus")))
        .toBe(true);
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => personalTab.getAttribute("aria-selected")).toBe("true");
      expect(await github.getByLabel("GITHUB_TOKEN", { exact: true }).inputValue()).toBe(
        "fixture-admin-personal-draft",
      );
      await capture(page, "10-credentials-admin-personal-draft.png");
    } finally {
      await closeContext(current, page, "credentials-administration.webm");
    }
  });
});
