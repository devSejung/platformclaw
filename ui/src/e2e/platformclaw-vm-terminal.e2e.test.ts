import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
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
const screenshotPath = process.env.PLATFORMCLAW_VM_TERMINAL_SCREENSHOT?.trim();

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("PlatformClaw personal VM terminal", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows one login-shell tab with no host upload or extra-session controls", async () => {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      (
        window as Window & {
          ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
        gatewayUrl: "ws://gateway.example.test",
        token: "test",
      };
    });
    const gateway = await installMockGateway(page, {
      defaultAgentId: "person_one",
      featureCapabilities: ["platformclaw.personal-vm-terminal"],
      featureMethods: [
        "terminal.attach",
        "terminal.close",
        "terminal.input",
        "terminal.list",
        "terminal.open",
        "terminal.resize",
      ],
      methodResponses: {
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "person_one",
          buffer: "Welcome to Development VM\r\nperson_one@dev-vm:~$ ",
          confined: true,
          cwd: "/home/person_one",
          seq: 54,
          sessionId: "platformclaw-vm-terminal",
          shell: "person_one login shell",
          title: "Development VM",
        },
      },
      operatorScopes: ["operator.read", "operator.write"],
      terminalEnabled: true,
    });

    try {
      await page.goto(server.baseUrl);
      await waitForControlUiGatewayReady(page);
      await waitForControlUiTerminalReady(page);
      await page.evaluate(() => {
        const panel = document.querySelector("openclaw-terminal-panel") as
          | (HTMLElement & { singleSession: boolean; uploadsEnabled: boolean })
          | null;
        if (!panel) {
          throw new Error("terminal panel unavailable");
        }
        panel.singleSession = true;
        panel.uploadsEnabled = false;
      });
      await page.keyboard.press("Control+Backquote");
      await gateway.waitForRequest("terminal.open");
      const panel = page.locator("openclaw-terminal-panel");
      await panel.locator(".tp-host canvas").waitFor({ state: "visible" });

      expect(await panel.locator(".tabstrip-tab__label").textContent()).toContain("Development VM");
      expect(await panel.locator(".tabstrip-new").count()).toBe(0);
      expect(await panel.locator(".tp-upload").count()).toBe(0);
      expect(await panel.locator(".terminal-session-picker").count()).toBe(0);
      expect(await gateway.getRequests("terminal.open")).toHaveLength(1);

      if (screenshotPath) {
        await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath, animations: "disabled", caret: "hide" });
      }
    } finally {
      await context.close();
    }
  });
});
