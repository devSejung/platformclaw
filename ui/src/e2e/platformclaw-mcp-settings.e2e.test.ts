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

async function installComponent(page: Page, kind = "mcp-settings"): Promise<void> {
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({
    type: "module",
    url: `${server.baseUrl}src/platformclaw/${kind}.ts`,
  });
  await page.evaluate(async (tag) => {
    await customElements.whenDefined(tag);
    document.body.replaceChildren(document.createElement(tag));
  }, `platformclaw-${kind}`);
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

  it("exercises every administrator editor field, failure recovery, cancel, edit, toggle and removal", async () => {
    const { context, page } = await newProofPage();
    const entry = {
      name: "draft",
      enabled: false,
      transport: "sse",
      target: "https://draft.example/mcp",
      editable: true,
      credentialMode: "none",
      toolPolicy: "blocked",
      blockedTools: ["delete"],
    };
    let servers: (typeof entry)[] = [];
    let release!: () => void;
    let mutations = 0;
    await page.route("**/platformclaw/api/admin/mcp", async (route) => {
      if (route.request().method() === "POST") {
        mutations += 1;
        if (mutations === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          await route.fulfill({ status: 503, json: { error: "Save failed. Try again." } });
          return;
        }
        const body = route.request().postDataJSON();
        if (body.action === "remove-server") servers = [];
        else servers = [{ ...entry, enabled: body.enabled }];
      }
      await route.fulfill({ json: { servers } });
    });
    try {
      await page.goto(new URL("sw.js", server.baseUrl).href);
      await installComponent(page, "mcp-administration");
      const component = page.locator("platformclaw-mcp-administration");
      const add = component.locator("[data-action='add']");
      await add.click();
      await component.locator("[name='name']").fill("discard");
      await component.locator("[data-action='cancel']").click();
      await add.click();
      expect(await component.locator("[name='name']").inputValue()).toBe("");
      await component.locator("[type='submit']").click();
      expect(mutations).toBe(0);
      await component.locator("[name='name']").fill("draft");
      await component.locator("[name='url']").fill("https://draft.example/mcp");
      await component.locator("[name='transport']").selectOption("sse");
      await component.locator("[name='credentialMode']").selectOption("personal");
      await component.locator("[name='auth']").selectOption("oauth");
      await component.locator("[name='scope']").fill("read:docs");
      await component.locator("[name='credentialMode']").selectOption("shared");
      expect(await component.locator("[name='auth']").inputValue()).toBe("bearer");
      await component.locator("[name='auth']").selectOption("api_key");
      await component.locator("[name='headerName']").fill("X-Fixture-Key");
      await component.locator("[name='secret']").fill("fixture-only");
      await component.locator("[name='blockedTools']").fill("delete");
      await component.locator("[name='enabled']").uncheck();
      await component.locator("[type='submit']").click();
      await expect.poll(() => mutations).toBe(1);
      expect(
        await component
          .locator("button:enabled, input:enabled, select:enabled, textarea:enabled")
          .count(),
      ).toBe(0);
      release();
      await expect.poll(() => component.getByRole("status").textContent()).toContain("Save failed");
      expect(await component.locator("[name='name']").inputValue()).toBe("draft");
      expect(await component.locator("[name='secret']").inputValue()).toBe("fixture-only");
      expect(await component.locator("[name='enabled']").isChecked()).toBe(false);
      await screenshot(page, "07-admin-failed-draft.png");
      await component.locator("[name='credentialMode']").selectOption("none");
      await component.locator("[type='submit']").click();
      await component.locator("[data-action='edit']").click();
      expect(await component.locator("[name='name']").getAttribute("readonly")).not.toBeNull();
      await component.locator("[data-action='cancel']").click();
      await component.locator("[data-action='toggle']").click();
      await expect.poll(() => component.locator(".status").textContent()).toBe("Enabled");
      page.once("dialog", (dialog) => dialog.dismiss());
      await component.locator("[data-action='remove']").click();
      expect(mutations).toBe(3);
      page.once("dialog", (dialog) => dialog.accept());
      await component.locator("[data-action='remove']").click();
      await expect.poll(() => component.locator(".card").count()).toBe(0);
      await screenshot(page, "08-admin-removed-empty.png");
    } finally {
      release?.();
      await closeProofPage(context, page, "admin-controls.webm");
    }
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
