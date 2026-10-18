import { chromium, type Browser } from "playwright";
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

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("PlatformClaw execution credentials", () => {
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

  it("retains a sibling input node, draft, focus, and caret through a save, error, and removal on PC", async () => {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
    let configured = false;
    let revision = 0;
    let definitionsVisible = true;
    let failNext = false;
    let resolveFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      resolveFirstSave = resolve;
    });
    const mutations: unknown[] = [];
    await page.route("**/platformclaw/api/exec-credentials", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        mutations.push(body);
        if (mutations.length === 1) {
          await firstSave;
        }
        if (failNext) {
          failNext = false;
          await route.fulfill({ status: 503, json: { error: "Credential service unavailable" } });
          return;
        }
        configured = body.action === "replace";
        if (configured) {
          revision++;
        }
        await route.fulfill({ json: { envName: "API_TOKEN", revision } });
        return;
      }
      await route.fulfill({
        json: {
          accountId: "account-a",
          definitions: definitionsVisible
            ? [
                { envName: "API_TOKEN", configured, revision },
                { envName: "SECOND_TOKEN", configured: false },
              ]
            : [],
        },
      });
    });

    try {
      await page.goto(new URL("sw.js", server.baseUrl).href);
      await page.setContent("<!doctype html><html><body></body></html>");
      await page.addScriptTag({
        type: "module",
        url: `${server.baseUrl}src/platformclaw/exec-credentials.ts`,
      });
      await page.evaluate(async () => {
        await customElements.whenDefined("platformclaw-exec-credentials");
        document.body.replaceChildren(document.createElement("platformclaw-exec-credentials"));
      });

      const component = page.locator("platformclaw-exec-credentials");
      const input = component.getByLabel("API_TOKEN");
      const sibling = component.getByLabel("SECOND_TOKEN");
      const save = component.locator("[data-action='save'][data-env='API_TOKEN']");
      await input.waitFor();

      await input.fill("   ");
      expect(await save.isDisabled()).toBe(true);
      expect(mutations).toEqual([]);

      await input.fill(" fixture-only ");
      await sibling.fill("synthetic-unsaved-only");
      const siblingNode = await sibling.evaluateHandle((element) => element as HTMLInputElement);
      await save.click();
      await expect.poll(() => mutations.length).toBe(1);
      expect(await sibling.isEnabled()).toBe(true);
      await sibling.press("Home");
      await sibling.press("ArrowRight");
      resolveFirstSave();
      await expect.poll(() => component.getByText("Saved", { exact: true }).isVisible()).toBe(true);
      expect(mutations).toEqual([
        {
          action: "replace",
          envName: "API_TOKEN",
          value: " fixture-only ",
          expectedAccountId: "account-a",
        },
      ]);
      await expect
        .poll(async () => (await component.getByRole("status").textContent())?.trim())
        .toBe("Saved.");
      expect(
        await siblingNode.evaluate((element) => ({
          sameNode: element === document.querySelector('[data-value="SECOND_TOKEN"]'),
          focused: element === document.activeElement,
          value: element.value,
          selectionStart: element.selectionStart,
          selectionEnd: element.selectionEnd,
        })),
      ).toEqual({
        sameNode: true,
        focused: true,
        value: "synthetic-unsaved-only",
        selectionStart: 1,
        selectionEnd: 1,
      });
      await sibling.press("X");
      expect(await sibling.inputValue()).toBe("sXynthetic-unsaved-only");

      failNext = true;
      await input.fill("replacement");
      await save.click();
      await component.getByText("Credential request failed.", { exact: true }).waitFor();
      expect(await input.isEnabled()).toBe(true);
      expect(await input.inputValue()).toBe("replacement");

      await component.getByRole("button", { name: "Remove", exact: true }).click();
      await expect
        .poll(() => component.getByText("Not configured", { exact: true }).count())
        .toBe(1);
      expect(await sibling.inputValue()).toBe("sXynthetic-unsaved-only");
      expect(mutations.at(-1)).toEqual({
        action: "remove",
        envName: "API_TOKEN",
        expectedAccountId: "account-a",
      });

      definitionsVisible = false;
      await page.evaluate(() => {
        const element = document.querySelector("platformclaw-exec-credentials");
        element?.remove();
        document.body.append(document.createElement("platformclaw-exec-credentials"));
      });
      await component
        .getByText("No environment variables are allowed yet.", { exact: true })
        .waitFor();
    } finally {
      resolveFirstSave();
      await page.close();
    }
  });
});
