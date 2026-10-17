import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  installSkillHubFixture,
  screenshotInstallation,
} from "./skill-hub-installation.e2e.test-helpers.ts";

const suite = createControlUiE2eSuite({
  name: "Skill Hub installation destinations",
  unavailableMessage: (executablePath) => `Playwright Chromium unavailable at ${executablePath}`,
  trackBrowserContexts: true,
});

async function newPage(locale = "en-US") {
  const context = await suite.newBrowserContext({
    locale,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const fixture = await installSkillHubFixture(page, suite.server.baseUrl);
  return { page, ...fixture };
}

suite.define(() => {
  it("reads each target independently, blocks the installed version and confirms version changes", async () => {
    const { page, reads, installs, executionMutations, gateway } = await newPage();
    await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
    await page.locator(".skill-hub-card", { hasText: "release-checklist" }).click();
    const detail = page.locator(".skill-hub-detail");
    const basic = detail.locator('[data-install-target="platform_server"]');
    const vm = detail.locator('[data-install-target="assigned_vm"]');
    await expect.poll(() => basic.locator("button").first().isEnabled()).toBe(true);
    await expect.poll(() => vm.textContent()).toContain("2.3.0");
    expect(await vm.locator("button").first().isDisabled()).toBe(true);
    expect(new Set(reads)).toEqual(new Set(["platform_server", "assigned_vm"]));
    await screenshotInstallation(page, "01-desktop-targets.png");

    await basic.locator("button").first().click();
    await expect.poll(() => basic.textContent()).toContain("2.3.0");
    expect(await basic.locator("button").first().isDisabled()).toBe(true);
    expect(installs).toEqual([
      {
        namespace: "engineering",
        slug: "release-checklist",
        version: "2.3.0",
        destination: "platform_server",
      },
    ]);
    await detail.locator('input[type="radio"][value="1.4.0"]').check();
    await expect.poll(() => basic.locator("button").first().isEnabled()).toBe(true);
    expect(await vm.locator("button").first().isEnabled()).toBe(true);
    await vm.locator("button").first().click();
    const confirmation = page.locator(".skill-hub-version-change");
    await expect.poll(() => confirmation.isVisible()).toBe(true);
    expect(await confirmation.textContent()).toContain("2.3.0");
    expect(await confirmation.textContent()).toContain("1.4.0");
    await screenshotInstallation(page, "02-version-change.png");
    await confirmation
      .getByRole("button", { name: "Replace installed version", exact: true })
      .click();
    await expect.poll(() => confirmation.count()).toBe(0);
    await expect.poll(() => vm.textContent()).toContain("1.4.0");
    expect(await vm.locator("button").first().isDisabled()).toBe(true);
    expect(await basic.locator("button").first().isEnabled()).toBe(true);
    expect(installs.at(-1)).toEqual({
      namespace: "engineering",
      slug: "release-checklist",
      version: "1.4.0",
      destination: "assigned_vm",
      acknowledgedReplacement: true,
      currentRevision: "vm-r1",
    });
    expect(executionMutations).toEqual([]);
    expect(await gateway.getRequests("platformclaw-execution.changeTarget")).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    await basic.scrollIntoViewIfNeeded();
    const geometry = await detail.evaluate((element) => {
      const controls = [...element.querySelectorAll<HTMLElement>("button, input")];
      return controls.every((control) => {
        const rect = control.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth;
      });
    });
    expect(geometry).toBe(true);
    await screenshotInstallation(page, "03-mobile-targets.png");
  });

  it("disables an unassigned VM with a visible reason and never queries its workspace", async () => {
    const { page, config, reads } = await newPage();
    config.installTargets![1] = {
      target: "assigned_vm",
      available: false,
      status: "unassigned",
      disabledReason: "No development VM is assigned. Set up a VM in execution settings first.",
    };
    await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
    await page.locator(".skill-hub-card", { hasText: "release-checklist" }).click();
    const basic = page.locator('[data-install-target="platform_server"]');
    const vm = page.locator('[data-install-target="assigned_vm"]');
    await expect.poll(() => basic.locator("button").first().isEnabled()).toBe(true);
    expect(await vm.locator("button").first().isDisabled()).toBe(true);
    expect(await vm.textContent()).toContain("No VM is assigned");
    expect(reads).toEqual(["platform_server"]);
    await screenshotInstallation(page, "04-no-vm-desktop.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await vm.scrollIntoViewIfNeeded();
    await screenshotInstallation(page, "05-no-vm-mobile.png");
  });

  it("keeps Basic server usable when the VM cannot connect, then recovers through retry", async () => {
    const { page, controls, installs } = await newPage();
    let unreachable = true;
    controls.inventoryHook = async (route, target) => {
      if (target !== "assigned_vm" || !unreachable) {
        return false;
      }
      await route.fulfill({
        status: 503,
        json: { error: "VM connection is unavailable. Check VM settings and retry." },
      });
      return true;
    };
    await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
    await page.locator(".skill-hub-card", { hasText: "release-checklist" }).click();
    const basic = page.locator('[data-install-target="platform_server"]');
    const vm = page.locator('[data-install-target="assigned_vm"]');
    await expect.poll(() => basic.locator("button").first().isEnabled()).toBe(true);
    await expect.poll(() => vm.textContent()).toContain("Cannot check skills on your VM right now");
    expect(await vm.locator("button").first().isDisabled()).toBe(true);
    await screenshotInstallation(page, "06-vm-unreachable.png");
    await basic.locator("button").first().click();
    await expect.poll(() => basic.locator("button").first().isDisabled()).toBe(true);
    expect(installs[0]?.destination).toBe("platform_server");
    unreachable = false;
    await vm.getByRole("button", { name: /retry|check again/i }).click();
    await expect.poll(() => vm.textContent()).toContain("2.3.0");
    expect(await vm.locator("button").first().isDisabled()).toBe(true);
  });

  it("disables installation while checking and ignores an old workspace response after switching skills", async () => {
    const { page, controls } = await newPage();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstBasicRead = true;
    controls.inventoryHook = async (route, target) => {
      if (target !== "platform_server" || !firstBasicRead) {
        return false;
      }
      firstBasicRead = false;
      await pending;
      await route.fulfill({
        json: {
          source: target,
          items: [{ skillKey: "incident-guide", version: "2.3.0", revision: "old-r1" }],
        },
      });
      return true;
    };
    await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
    await page.locator(".skill-hub-card", { hasText: "release-checklist" }).click();
    const detail = page.locator(".skill-hub-detail");
    const basic = detail.locator('[data-install-target="platform_server"]');
    await expect.poll(() => basic.isVisible()).toBe(true);
    expect(await basic.locator("button").first().isDisabled()).toBe(true);
    await screenshotInstallation(page, "07-checking-workspace.png");
    await detail.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".skill-hub-card", { hasText: "incident-guide" }).click();
    await expect.poll(() => basic.locator("button").first().isEnabled()).toBe(true);
    const oldResponse = page.waitForResponse((response) =>
      response.url().includes("workspace-skills?source=platform_server"),
    );
    release();
    await (await oldResponse).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(await detail.locator("h2").textContent()).toBe("Incident guide");
    expect(await basic.locator("button").first().isEnabled()).toBe(true);
    expect(await basic.textContent()).toContain("Not downloaded to this location yet");
  });

  it("explains the installed version and missing VM in Korean", async () => {
    const { page, config, inventories } = await newPage("ko-KR");
    inventories.platform_server = [
      { skillKey: "release-checklist", version: "2.3.0", revision: "basic-r1" },
    ];
    config.installTargets![1] = { target: "assigned_vm", available: false, status: "unassigned" };
    await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
    await page.locator(".skill-hub-card", { hasText: "release-checklist" }).click();
    const basic = page.locator('[data-install-target="platform_server"]');
    const vm = page.locator('[data-install-target="assigned_vm"]');
    await expect.poll(() => basic.textContent()).toContain("2.3.0");
    expect(await basic.textContent()).toContain("이미 다운로드");
    expect(await vm.textContent()).toContain("할당된 VM이 없습니다");
    expect(await basic.locator("button").first().isDisabled()).toBe(true);
    expect(await vm.locator("button").first().isDisabled()).toBe(true);
    await screenshotInstallation(page, "08-korean-desktop.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await vm.scrollIntoViewIfNeeded();
    await screenshotInstallation(page, "09-korean-mobile.png");
  });
});
