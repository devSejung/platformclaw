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
const videoDir = process.env.PLATFORMCLAW_VM_TERMINAL_VIDEO_DIR?.trim();

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

  it.each(["", "?view=terminal"])(
    "opens eight VM tabs and disables the ninth without host upload (%s)",
    async (query) => {
      const context = await browser.newContext({
        serviceWorkers: "block",
        viewport: { width: 1920, height: 1080 },
        ...(videoDir
          ? { recordVideo: { dir: videoDir, size: { width: 1920, height: 1080 } } }
          : {}),
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
        await page.goto(`${server.baseUrl}${query}`);
        await waitForControlUiGatewayReady(page);
        await waitForControlUiTerminalReady(page);
        expect(
          await page.evaluate(() => {
            const panel = document.querySelector("openclaw-terminal-panel") as HTMLElement & {
              maxSessions: number;
              uploadsEnabled: boolean;
            };
            return { maxSessions: panel.maxSessions, uploadsEnabled: panel.uploadsEnabled };
          }),
        ).toEqual({ maxSessions: 8, uploadsEnabled: false });
        if (!query) {
          await page.keyboard.press("Control+Backquote");
        }
        await gateway.waitForRequest("terminal.open");
        const panel = page.locator("openclaw-terminal-panel");
        await panel.locator(".tp-host canvas").waitFor({ state: "visible" });

        expect(await panel.locator(".tabstrip-tab__label").textContent()).toContain(
          "Development VM",
        );
        expect(await panel.locator(".tabstrip-new").count()).toBe(1);
        expect(await panel.locator(".tp-upload").count()).toBe(0);
        expect(await panel.locator(".tp-session-picker").count()).toBe(1);
        if (query) {
          expect(await panel.locator(".tp-actions > .tp-icon").count()).toBe(0);
        }
        for (let index = 2; index <= 8; index += 1) {
          await gateway.setMethodResponse("terminal.open", {
            sessionId: `platformclaw-vm-terminal-${index}`,
            agentId: "person_one",
            confined: true,
            shell: "person_one login shell",
            cwd: "/home/person_one",
            title: `Development VM ${index}`,
            buffer: `person_one@dev-vm:~$ `,
            seq: 23,
          });
          await panel.locator(".tabstrip-new").click();
          await page.waitForFunction(
            (count) =>
              document
                .querySelector("openclaw-terminal-panel")
                ?.shadowRoot?.querySelectorAll(".tabstrip-tab").length === count,
            index,
          );
          await panel.locator(".tp-host canvas:visible").waitFor({ state: "visible" });
        }
        expect(await panel.locator(".tabstrip-tab").count()).toBe(8);
        expect(await panel.locator(".tabstrip-new").isDisabled()).toBe(true);
        expect(await gateway.getRequests("terminal.open")).toHaveLength(8);
        const listedBeforePicker = (await gateway.getRequests("terminal.list")).length;
        await panel.locator(".tp-session-picker > button").click();
        await expect
          .poll(async () => (await gateway.getRequests("terminal.list")).length)
          .toBe(listedBeforePicker + 1);
        expect(await panel.locator(".tp-session-menu").count()).toBe(1);
        await panel.locator(".tp-session-picker > button").click();

        if (screenshotPath) {
          await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
          const capturePath = query
            ? screenshotPath.replace(/(\.[^.]+)$/u, ".native$1")
            : screenshotPath;
          await page.screenshot({ path: capturePath, animations: "disabled", caret: "hide" });
        }
      } finally {
        await context.close();
      }
    },
  );
});
