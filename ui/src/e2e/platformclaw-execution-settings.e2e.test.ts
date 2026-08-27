import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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
  "platformclaw-execution-settings",
);

let browser: Browser;
let server: ControlUiE2eServer;

async function screenshot(page: Page, name: string): Promise<void> {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ animations: "disabled", path: path.join(proofDir, name) });
}

describeControlUiE2e("PlatformClaw employee execution settings", () => {
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

  it("updates the quick-action work-location label after switching to Basic", async () => {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 574, height: 789 } });
    const vmSettings = {
      activeTarget: "assigned_vm",
      targetRevision: 3,
      credentialStatus: "current",
      accountId: "person.one",
      availableVms: [{ id: "development", label: "Development VM" }],
      assignment: {
        vmHostId: "development",
        status: "ready",
        vmLabel: "Development VM",
        safeConnectLabel: "Corporate access",
        linuxAccount: "person.one",
        remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
        lastConnectionSucceededAt: 1_787_642_400_000,
      },
    };
    const basicSettings = { ...vmSettings, activeTarget: "platform_server", targetRevision: 4 };
    await page.route("**/platformclaw/api/execution**", async (route) => {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({
          expectedRevision: 3,
          target: "platform_server",
        });
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(basicSettings),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(vmSettings),
      });
    });
    await page.goto(new URL("sw.js", server.baseUrl).href);
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({
      type: "module",
      url: `${server.baseUrl}src/platformclaw/quick-actions.ts`,
    });
    const initialRefresh = page.waitForResponse("**/platformclaw/api/execution");
    await page.evaluate(async () => {
      localStorage.setItem("platformclaw.product-tour.v1.completed", "true");
      await customElements.whenDefined("platformclaw-quick-actions");
      document.body.replaceChildren(document.createElement("platformclaw-quick-actions"));
    });
    await initialRefresh;

    const component = page
      .locator("platformclaw-quick-actions")
      .locator("platformclaw-execution-settings");
    const badge = component.getByRole("button", { name: "Open work location settings" });
    await expect.poll(async () => await badge.textContent()).toContain("My development VM");
    await badge.click();
    await expect
      .poll(async () => await component.getByRole("dialog", { name: "Work location" }).isVisible())
      .toBe(true);
    await component.getByRole("button", { name: "Use Basic workspace" }).click();
    await expect
      .poll(async () => component.getByText("Change work location?", { exact: true }).isVisible())
      .toBe(true);
    await expect
      .poll(async () =>
        component
          .getByText(
            "Change to Basic workspace. Conversation and Agent settings stay, but files and running processes remain in the previous location.",
          )
          .isVisible(),
      )
      .toBe(true);
    const confirmButton = component.getByRole("button", { name: "Change location" });
    await expect
      .poll(() =>
        confirmButton.evaluate(
          (element) => (element.getRootNode() as ShadowRoot).activeElement === element,
        ),
      )
      .toBe(true);
    const footerBox = await component.locator("[data-confirmation-footer]").boundingBox();
    const confirmBox = await confirmButton.boundingBox();
    expect(footerBox).not.toBeNull();
    expect(confirmBox).not.toBeNull();
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(789);
    expect(confirmBox!.y + confirmBox!.height).toBeLessThanOrEqual(789);
    await screenshot(page, "01-confirm-basic-switch-narrow.png");
    await confirmButton.click();
    await expect.poll(async () => await badge.textContent()).toContain("Basic workspace");
    await screenshot(page, "02-basic-workspace-active.png");
    await page.close();
  });
});
