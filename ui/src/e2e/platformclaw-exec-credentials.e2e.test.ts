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

  it("validates, saves, reports an error, removes, and shows the empty state on PC", async () => {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
    let configured = false;
    let definitionsVisible = true;
    let failNext = false;
    const mutations: unknown[] = [];
    await page.route("**/platformclaw/api/exec-credentials", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        mutations.push(body);
        if (failNext) {
          failNext = false;
          await route.fulfill({ status: 503, json: { error: "Credential service unavailable" } });
          return;
        }
        configured = body.action === "replace";
      }
      await route.fulfill({
        json: {
          definitions: definitionsVisible ? [{ envName: "API_TOKEN", configured }] : [],
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
      const save = component.getByRole("button", { name: "Save", exact: true });
      await input.waitFor();

      await input.fill("   ");
      await save.click();
      expect(mutations).toEqual([]);
      expect(
        await input.evaluate((element) => (element as HTMLInputElement).validity.valueMissing),
      ).toBe(true);

      await input.fill(" fixture-only ");
      await save.click();
      await expect
        .poll(() => component.getByText("Configured", { exact: true }).isVisible())
        .toBe(true);
      expect(mutations).toEqual([
        { action: "replace", envName: "API_TOKEN", value: " fixture-only " },
      ]);
      await expect.poll(() => component.getByRole("status").textContent()).toBe("Saved.");

      failNext = true;
      await input.fill("replacement");
      await save.click();
      await component.getByText("Credential service unavailable", { exact: true }).waitFor();
      expect(await input.isEnabled()).toBe(true);
      expect(await input.inputValue()).toBe("replacement");

      await component.getByRole("button", { name: "Remove", exact: true }).click();
      await expect
        .poll(() => component.getByText("Not configured", { exact: true }).isVisible())
        .toBe(true);
      expect(mutations.at(-1)).toEqual({ action: "remove", envName: "API_TOKEN" });

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
      await page.close();
    }
  });
});
