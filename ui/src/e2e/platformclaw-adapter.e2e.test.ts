import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "platformclaw-adapter");

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
  await page.route("**/platformclaw/app/**", async (route) => {
    const response = await page.request.get(server.baseUrl);
    const source = await response.text();
    const descriptor = `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>`;
    await route.fulfill({
      response,
      body: source.replace("</head>", `${descriptor}</head>`),
    });
  });
}

function activeSession() {
  return {
    authenticated: true,
    user: {
      accountId: "person.one",
      displayName: "Person One",
      department: "Platform Lab",
      globalRole: "user",
    },
    session: {
      idleExpiresAt: Date.now() + 60_000,
      absoluteExpiresAt: Date.now() + 120_000,
    },
  };
}

describeControlUiE2e("PlatformClaw Control UI adapter mocked Gateway E2E", () => {
  beforeAll(async () => {
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

  it("uses the cookie-authenticated proxy and falls back from disabled routes", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: activeSession(), status: 200 }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      sessionKey: "agent:person_one:main",
    });

    await page.goto(`${server.baseUrl}platformclaw/app/agents`);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/chat");
    await expect.poll(() => page.getByText("Person One").isVisible()).toBe(true);
    await expect.poll(() => page.getByText("Platform Lab").isVisible()).toBe(true);
    await expect
      .poll(() => page.locator(".agent-chat__composer-combobox textarea").isVisible())
      .toBe(true);
    await expect.poll(() => page.getByRole("link", { name: "Sessions" }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole("button", { name: "Settings" }).count()).toBe(0);

    const connect = (await gateway.getRequests("connect"))[0];
    expect(connect).toBeDefined();
    expect(connect?.params).not.toMatchObject({ auth: expect.anything() });
    expect(connect?.params).not.toMatchObject({ device: expect.anything() });
    expect(await gateway.getSocketUrls()).toContain(
      `${server.baseUrl.replace("http:", "ws:")}platformclaw/gateway`,
    );

    if (captureUiProofEnabled) {
      await mkdir(proofDir, { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "01-chat-ready.png"),
      });
    }
  });

  it("redirects to login when a policy close confirms session expiry", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    let sessionActive = true;
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({
        json: sessionActive ? activeSession() : { authenticated: false },
        status: 200,
      }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      sessionKey: "agent:person_one:main",
    });

    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await expect.poll(() => page.getByText("Person One").isVisible()).toBe(true);
    sessionActive = false;
    await gateway.closeLatest(1008, "session expired");

    await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/login");
  });
});
