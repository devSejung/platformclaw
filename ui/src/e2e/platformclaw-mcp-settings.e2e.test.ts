import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "platformclaw-mcp-settings",
);

let browser: Browser;
let server: ControlUiE2eServer;

async function newProofPage(): Promise<{ context: BrowserContext; page: Page }> {
  if (captureUiProof) {
    await mkdir(proofDir, { recursive: true });
  }
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    ...(captureUiProof
      ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } }
      : {}),
  });
  return { context, page: await context.newPage() };
}

async function installComponent(page: Page): Promise<void> {
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({
    type: "module",
    url: `${server.baseUrl}src/platformclaw/mcp-settings.ts`,
  });
  await page.evaluate(async () => {
    await customElements.whenDefined("platformclaw-mcp-settings");
    document.body.replaceChildren(document.createElement("platformclaw-mcp-settings"));
  });
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (captureUiProof) {
    await page.screenshot({ animations: "disabled", path: path.join(proofDir, name) });
  }
}

async function closeProofPage(
  context: BrowserContext,
  page: Page,
  videoName: string,
): Promise<void> {
  const video = page.video();
  await context.close();
  if (captureUiProof && video) {
    await video.saveAs(path.join(proofDir, videoName));
  }
}

describeControlUiE2e("PlatformClaw personal MCP browser settings", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("lets an employee save and remove only an administrator-approved API key", async () => {
    const { context, page } = await newProofPage();
    let configured = false;
    let mutation: unknown;
    await page.route("**/platformclaw/api/mcp", (route) =>
      route.fulfill({
        json: {
          servers: [
            {
              serverName: "docs",
              auth: "api_key",
              headerName: "X-Approved-Key",
              configured,
            },
          ],
        },
      }),
    );
    await page.route("**/platformclaw/api/mcp/credential", async (route) => {
      mutation = route.request().postDataJSON();
      configured = route.request().method() === "PUT";
      await route.fulfill({ json: { serverName: "docs", revision: 2 } });
    });

    await page.goto(new URL("sw.js", server.baseUrl).href);
    await installComponent(page);
    const component = page.locator("platformclaw-mcp-settings");
    await expect
      .poll(() => component.getByRole("heading", { name: "Your MCP credentials" }).isVisible())
      .toBe(true);
    await expect.poll(() => component.getByText("docs", { exact: true }).isVisible()).toBe(true);
    await expect.poll(() => component.getByText("X-Approved-Key").isVisible()).toBe(true);
    await screenshot(page, "01-approved-server.png");

    await component.getByLabel("API key for docs").fill("employee-secret");
    await screenshot(page, "02-credential-input.png");
    await component.getByRole("button", { name: "Save credentials for docs" }).click();
    await expect.poll(() => component.getByText("MCP connection updated.").isVisible()).toBe(true);
    await expect
      .poll(() => component.getByText("Connected", { exact: true }).isVisible())
      .toBe(true);
    expect(mutation).toEqual({
      serverName: "docs",
      kind: "api_key",
      secret: "employee-secret",
    });
    await screenshot(page, "03-connected.png");

    page.once("dialog", (dialog) => dialog.accept());
    await component.getByRole("button", { name: "Remove credentials for docs" }).click();
    await expect
      .poll(() => component.getByText("Not connected", { exact: true }).isVisible())
      .toBe(true);
    await screenshot(page, "04-removed.png");
    await closeProofPage(context, page, "api-key-flow.webm");
  });

  it("shows OAuth scope, reports callback success, and performs real authorization navigation", async () => {
    const { context, page } = await newProofPage();
    await page.route("**/platformclaw/api/mcp", (route) =>
      route.fulfill({
        json: {
          servers: [
            {
              serverName: "github",
              auth: "oauth",
              scope: "repo:read",
              configured: true,
            },
          ],
        },
      }),
    );
    await page.route("**/platformclaw/api/mcp/oauth/start", (route) =>
      route.fulfill({
        json: {
          status: "redirect",
          authorizationUrl: "https://auth.example.test/authorize",
        },
      }),
    );
    await page.route("https://auth.example.test/authorize", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Authorization server</h1>" }),
    );

    await page.goto(new URL("sw.js?mcpOAuth=success", server.baseUrl).href);
    await installComponent(page);
    const component = page.locator("platformclaw-mcp-settings");
    await expect
      .poll(() => component.getByText("OAuth connection completed.").isVisible())
      .toBe(true);
    await expect.poll(() => component.getByText("Scope: repo:read").isVisible()).toBe(true);
    await expect
      .poll(() =>
        component.getByRole("button", { name: "Reconnect github with OAuth" }).isVisible(),
      )
      .toBe(true);
    expect(new URL(page.url()).searchParams.has("mcpOAuth")).toBe(false);
    await screenshot(page, "05-oauth-complete.png");

    await component.getByRole("button", { name: "Reconnect github with OAuth" }).click();
    await page.waitForURL("https://auth.example.test/authorize");
    await expect
      .poll(() => page.getByRole("heading", { name: "Authorization server" }).isVisible())
      .toBe(true);
    await screenshot(page, "06-oauth-navigation.png");
    await closeProofPage(context, page, "oauth-flow.webm");
  });
});
