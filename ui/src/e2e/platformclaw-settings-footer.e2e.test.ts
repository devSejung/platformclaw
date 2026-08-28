import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "platformclaw-settings-footer",
);

let server: ControlUiE2eServer;
let browser: Browser;
const contexts = new Set<BrowserContext>();

async function newPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  contexts.add(context);
  return { context, page: await context.newPage() };
}

async function installPlatformClawDocument(page: Page): Promise<void> {
  const response = await page.request.get(server.baseUrl);
  const source = await response.text();
  const headers = response.headers();
  await page.route("**/platformclaw/app/**", async (route) => {
    const descriptor = `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>`;
    await route.fulfill({
      body: source.replace("</head>", `${descriptor}</head>`),
      headers,
      status: response.status(),
    });
  });
}

async function openSettings(page: Page): Promise<void> {
  await page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`);
  const settingsSidebar = page.locator(".settings-sidebar");
  await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
  await settingsSidebar.getByRole("link", { name: "MCP", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/settings/mcp");
}

function session(globalRole: "member" | "admin") {
  return {
    authenticated: true,
    user: {
      accountId: "person.one",
      displayName: "Person One",
      department: "Platform Lab",
      globalRole,
    },
    agent: { agentId: "person_one", state: "active" },
    session: {
      idleExpiresAt: Date.now() + 60_000,
      absoluteExpiresAt: Date.now() + 120_000,
    },
  };
}

describeControlUiE2e("PlatformClaw settings footer quick actions", () => {
  beforeAll(async () => {
    if (captureUiProofEnabled) {
      await mkdir(proofDir, { recursive: true });
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterEach(async () => {
    await Promise.all([...contexts].map((context) => context.close().catch(() => {})));
    contexts.clear();
  });

  afterAll(async () => {
    await Promise.all([...contexts].map((context) => context.close().catch(() => {})));
    await browser?.close();
    await server?.close();
  });

  it("keeps the VM buttons readable for both member and admin settings", async () => {
    const roles = ["member", "admin"] as const;
    const executionSettings = {
      accountId: "person.one",
      activeTarget: "assigned_vm",
      assignment: {
        vmHostId: "development",
        status: "ready",
        vmLabel: "Development VM",
        safeConnectLabel: "Corporate access",
        linuxAccount: "person.one",
        remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
        lastConnectionSucceededAt: 1_787_642_400_000,
      },
      availableVms: [{ id: "development", label: "Development VM" }],
      credentialStatus: "current",
      targetRevision: 3,
    };

    for (const globalRole of roles) {
      const { page } = await newPage();
      await installPlatformClawDocument(page);
      await page.route("**/platformclaw/api/auth/session", (route) =>
        route.fulfill({ json: session(globalRole), status: 200 }),
      );
      await page.route("**/platformclaw/api/execution", (route) =>
        route.fulfill({ json: executionSettings, status: 200 }),
      );
      await page.route("**/platformclaw/api/mcp", (route) =>
        route.fulfill({ json: { servers: [] }, status: 200 }),
      );
      await page.route("**/platformclaw/api/admin/mcp", (route) =>
        route.fulfill({ json: { servers: [] }, status: 200 }),
      );
      await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: "person_one",
        featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
        operatorScopes:
          globalRole === "admin"
            ? ["operator.read", "operator.write", "operator.admin"]
            : ["operator.read", "operator.write"],
        sessionKey: "agent:person_one:main",
      });

      await openSettings(page);
      const accessory = page.locator(".settings-sidebar__footer-accessory");
      const quickActions = accessory.locator("platformclaw-quick-actions");
      await expect.poll(() => quickActions.isVisible()).toBe(true);
      const accessoryBox = await accessory.boundingBox();
      const quickActionsBox = await quickActions.boundingBox();
      expect(accessoryBox).not.toBeNull();
      expect(quickActionsBox).not.toBeNull();
      expect(quickActionsBox!.width).toBeGreaterThanOrEqual(accessoryBox!.width - 1);

      const buildRow = page.locator(".settings-sidebar__footer-build");
      const buildLink = buildRow.locator(".sidebar-footer-build");
      const buildRowBox = await buildRow.boundingBox();
      const buildLinkBox = await buildLink.boundingBox();
      expect(buildRowBox).not.toBeNull();
      expect(buildLinkBox).not.toBeNull();
      expect(buildRowBox!.width).toBeGreaterThanOrEqual(accessoryBox!.width - 1);
      expect(buildLinkBox!.y).toBeGreaterThanOrEqual(accessoryBox!.y + accessoryBox!.height - 1);

      const workLocationButton = quickActions
        .locator("platformclaw-execution-settings")
        .getByRole("button", { name: "Open work location settings" });
      await expect.poll(() => workLocationButton.isVisible()).toBe(true);
      await expect.poll(() => workLocationButton.textContent()).toContain("My development VM");
      const workLabelLineCount = await workLocationButton
        .locator("span")
        .nth(1)
        .evaluate((element) => element.getClientRects().length);
      expect(workLabelLineCount).toBe(1);

      const vmAdministration = quickActions.locator("platformclaw-vm-administration");
      if (globalRole === "admin") {
        await page.evaluate(() => customElements.whenDefined("platformclaw-vm-administration"));
        const vmAdministrationButton = vmAdministration.getByRole("button", {
          name: "VM administration",
        });
        await expect.poll(() => vmAdministrationButton.isVisible()).toBe(true);
        await expect
          .poll(() =>
            vmAdministrationButton.evaluate((button) => button.getBoundingClientRect().height),
          )
          .toBeLessThanOrEqual(40);
      } else {
        expect(await vmAdministration.count()).toBe(0);
      }

      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, `${globalRole}-settings-footer.png`),
        });
      }
      await page.close();
    }
  });
});
