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

  it.each([
    { name: "narrow", viewport: { width: 574, height: 789 } },
    { name: "PC", viewport: { width: 1440, height: 900 } },
  ])(
    "updates the quick-action work-location label after switching to Basic on $name",
    async ({ name, viewport }) => {
      const page = await browser.newPage({ locale: "en-US", viewport });
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
      let failSwitch = name === "PC";
      await page.route("**/platformclaw/api/execution**", async (route) => {
        if (new URL(route.request().url()).pathname.endsWith("/coding-agent")) {
          const body = route.request().postDataJSON();
          expect(["codex", "opencode"]).toContain(body.agent);
          expect(body).toEqual({ agent: body.agent, expectedRevision: 3 });
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ agent: body.agent, reportedVersion: "1.2.3" }),
          });
          return;
        }
        if (route.request().method() === "POST") {
          expect(route.request().postDataJSON()).toEqual({
            expectedRevision: 3,
            target: "platform_server",
          });
          if (failSwitch) {
            failSwitch = false;
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "Fixture work-location switch failed" }),
            });
            return;
          }
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
        .poll(
          async () => await component.getByRole("dialog", { name: "Work location" }).isVisible(),
        )
        .toBe(true);
      for (const agent of ["codex", "opencode"]) {
        const card = component.locator(`[data-coding-agent='${agent}']`);
        await card.getByRole("button", { name: "Check VM installation" }).click();
        await expect.poll(() => card.textContent()).toContain("Installed: 1.2.3");
        await screenshot(page, `coding-agent-${agent}-installed.png`);
      }
      await component.getByRole("button", { name: "Use Basic workspace" }).click();
      if (name === "PC") {
        await component.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(await component.locator("[data-action='confirm-switch']").count()).toBe(0);
        await component.getByRole("button", { name: "Use Basic workspace" }).click();
        await page.keyboard.press("Escape");
        await expect.poll(() => component.getByRole("dialog").count()).toBe(0);
        await badge.click();
        expect(await component.locator("[data-action='confirm-switch']").count()).toBe(0);
        await component.getByRole("button", { name: "Use Basic workspace" }).click();
      }
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
      expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(viewport.height);
      expect(confirmBox!.y + confirmBox!.height).toBeLessThanOrEqual(viewport.height);
      await screenshot(page, "01-confirm-basic-switch-narrow.png");
      if (name === "PC") {
        await confirmButton.click();
        await component.getByText("Fixture work-location switch failed", { exact: true }).waitFor();
        expect(await component.locator("[data-action='confirm-switch']").count()).toBe(1);
        await expect.poll(() => confirmButton.isEnabled()).toBe(true);
        await expect.poll(async () => await badge.textContent()).toContain("My development VM");
      }
      await confirmButton.click();
      await expect.poll(async () => await badge.textContent()).toContain("Basic workspace");
      await screenshot(page, "02-basic-workspace-active.png");
      await page.close();
    },
  );
  it("exercises credentials, VM selection, coding setup, release, empty and error states on PC", async () => {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
    let current: Record<string, unknown> = {
      activeTarget: "platform_server",
      targetRevision: 3,
      credentialStatus: "current",
      accountId: "person.one",
      availableVms: [{ id: "vm-one", label: "Development VM" }],
      assignment: {
        vmHostId: "vm-one",
        status: "ready",
        vmLabel: "Development VM",
        linuxAccount: "person.one",
        safeConnectLabel: "Corporate access",
      },
    };
    let failNext = false;
    let hold: Promise<void> | undefined;
    const requests: Array<{ path: string; body: unknown }> = [];
    await page.route("**/platformclaw/api/execution**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (hold) {
        await hold;
        hold = undefined;
      }
      if (failNext) {
        failNext = false;
        await route.fulfill({ status: 503, json: { error: "Fixture unavailable" } });
        return;
      }
      if (request.method() === "POST") {
        const body = request.postData() ? request.postDataJSON() : undefined;
        requests.push({ path: pathname, body });
        if (pathname.endsWith("/claude-code")) {
          current = {
            ...current,
            claudeCode: {
              executablePath: body.executablePath ?? "/opt/claude",
              reportedVersion: "Claude fixture",
              validatedAt: 1,
            },
          };
        }
        if (pathname.endsWith("/release")) {
          const { assignment: _assignment, ...rest } = current;
          current = { ...rest, availableVms: [] };
        }
      }
      await route.fulfill({ json: current });
    });
    await page.goto(new URL("sw.js", server.baseUrl).href);
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({
      type: "module",
      url: `${server.baseUrl}src/platformclaw/execution-settings.ts`,
    });
    await page.evaluate(async () => {
      await customElements.whenDefined("platformclaw-execution-settings");
      document.body.replaceChildren(document.createElement("platformclaw-execution-settings"));
    });
    const component = page.locator("platformclaw-execution-settings");
    await component.locator("[data-action='open']").waitFor();
    await component.locator("[data-action='open']").click();
    await component.locator("[data-password]").waitFor();
    await component.locator("[data-password]").fill("fixture-only");
    await component.locator("[data-action='credential']").click();
    await expect.poll(() => requests.at(-1)?.path).toContain("/credential");
    await expect.poll(() => component.locator("[data-action='credential']").isEnabled()).toBe(true);
    expect(requests.at(-1)?.body).toEqual({ password: "fixture-only" });
    await component.locator("[data-action='test']").click();
    await expect.poll(() => requests.at(-1)?.path).toContain("/test");
    await expect
      .poll(() => component.locator("[data-action='claude-detect']").isEnabled())
      .toBe(true);
    await component.locator("[data-action='claude-detect']").click();
    await expect
      .poll(() => component.locator("[data-claude-path]").inputValue())
      .toBe("/opt/claude");
    await component.locator("[data-claude-path]").fill("/opt/custom-claude");
    await component.locator("[data-action='claude-save']").click();
    await expect
      .poll(() => requests.at(-1)?.body)
      .toEqual({ expectedRevision: 3, executablePath: "/opt/custom-claude" });
    await expect
      .poll(() => component.locator("[data-action='claude-save']").isEnabled())
      .toBe(true);
    const selectForm = component.locator("form[data-action='select-vm']");
    await selectForm.locator("select").selectOption("vm-one");
    await selectForm.locator("input[name='linuxAccount']").fill("pc-user");
    await selectForm.locator("button").click();
    expect(
      await selectForm
        .locator("input[name='password']")
        .evaluate((input) => (input as HTMLInputElement).validity.valueMissing),
    ).toBe(true);
    await selectForm.locator("input[name='password']").fill("fixture-only");
    await selectForm.locator("button").click();
    await expect
      .poll(() => requests.at(-1)?.body)
      .toEqual({ vmHostId: "vm-one", linuxAccount: "pc-user", password: "fixture-only" });
    await expect.poll(() => component.locator("[data-action='release']").isEnabled()).toBe(true);
    await component.locator("[data-action='release']").click();
    await component.locator("[data-action='cancel-release']").click();
    expect(await component.locator("[data-action='confirm-release']").count()).toBe(0);
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await component.locator("[data-action='test']").click();
    expect(await component.locator("[data-action='credential']").isDisabled()).toBe(true);
    await component.locator("[data-action='close']").click();
    release();
    await expect.poll(() => component.locator("openclaw-modal-dialog").count()).toBe(0);
    await component.locator("[data-action='open']").click();
    await expect.poll(() => component.locator("[data-action='refresh']").isEnabled()).toBe(true);
    failNext = true;
    await component.locator("[data-action='refresh']").click();
    await component.getByText("Fixture unavailable", { exact: true }).waitFor();
    await component.locator("[data-action='refresh']").click();
    await expect
      .poll(() => component.getByText("Fixture unavailable", { exact: true }).count())
      .toBe(0);
    await component.locator("[data-action='release']").click();
    await component.locator("[data-action='confirm-release']").click();
    await component
      .getByText("No development VM is currently available.", { exact: true })
      .waitFor();
    await screenshot(page, "PC-empty-after-release.png");
    await page.close();
  });
});
