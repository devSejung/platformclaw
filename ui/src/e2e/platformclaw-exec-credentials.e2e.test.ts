import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { installCredentialApi } from "./platformclaw-credentials.test-support.ts";

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

  it("retains the selected sibling's input node, draft, focus, and caret through another key's save", async () => {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
    const api = await installCredentialApi(page, {
      accountId: "account-a",
      keys: ["API_TOKEN", "SECOND_TOKEN"],
    });
    const release = api.deferNextSave("API_TOKEN");
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
      const input = component.getByLabel("API_TOKEN", { exact: true });
      const sibling = component.getByLabel("SECOND_TOKEN", { exact: true });
      const save = component.locator("[data-action='save'][data-env='API_TOKEN']");
      const select = (envName: string) =>
        component.locator(`[data-action='select'][data-env='${envName}']`).click();
      await input.waitFor();
      await input.fill("   ");
      expect(await save.isDisabled()).toBe(true);
      expect(api.submissions).toEqual([]);

      await select("SECOND_TOKEN");
      await sibling.fill("synthetic-unsaved-only");
      const siblingNode = await sibling.evaluateHandle((element) => element as HTMLInputElement);
      await select("API_TOKEN");
      await input.fill(" fixture-only ");
      await save.click();
      await expect.poll(() => api.submissions.length).toBe(1);
      await select("SECOND_TOKEN");
      expect(await sibling.isEnabled()).toBe(true);
      await sibling.press("Home");
      await sibling.press("ArrowRight");
      release();
      await expect.poll(() => input.inputValue()).toBe("");
      expect(api.submissions).toEqual([
        {
          action: "replace",
          envName: "API_TOKEN",
          value: " fixture-only ",
          expectedAccountId: "account-a",
          expectedDefinitionToken: "definition-1",
          expectedCredentialToken: null,
        },
      ]);
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

      await select("API_TOKEN");
      api.failNextSave();
      await input.fill("replacement");
      await save.click();
      await component.getByText("Credential request failed.", { exact: true }).waitFor();
      expect(await input.isEnabled()).toBe(true);
      expect(await input.inputValue()).toBe("replacement");
      const savedToken = api.snapshot().definitions[0]!.credentialToken;
      await component.locator("[data-action='remove'][data-env='API_TOKEN']").click();
      await expect.poll(() => input.getAttribute("placeholder")).toBe("Enter a new value");
      expect(api.submissions.at(-1)).toEqual({
        action: "remove",
        envName: "API_TOKEN",
        expectedAccountId: "account-a",
        expectedDefinitionToken: "definition-1",
        expectedCredentialToken: savedToken,
      });
      await select("SECOND_TOKEN");
      expect(await sibling.inputValue()).toBe("sXynthetic-unsaved-only");

      api.removeAllDefinitions();
      await page.evaluate(() => {
        document.querySelector("platformclaw-exec-credentials")?.remove();
        document.body.append(document.createElement("platformclaw-exec-credentials"));
      });
      await component
        .getByText("No environment variables are allowed yet.", { exact: true })
        .waitFor();
    } finally {
      release();
      await page.close();
    }
  });
});
