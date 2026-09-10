import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";

/** Drive the route-changing half of the PlatformClaw guide without bloating the owning E2E. */
export async function runPlatformClawSettingsAndMemoryGuide(options: {
  captureUiProofEnabled: boolean;
  page: Page;
  proofDir: string;
  quickActions: Locator;
}): Promise<void> {
  const { captureUiProofEnabled, page, proofDir, quickActions } = options;
  await page.setViewportSize({ width: 1280, height: 640 });

  await page.getByRole("button", { name: "Next" }).click();
  await expect
    .poll(() =>
      page
        .getByRole("heading", { name: "Settings button: open all workspace settings" })
        .isVisible(),
    )
    .toBe(true);
  await expect.poll(() => page.url().includes("/chat/")).toBe(true);
  await expect.poll(() => page.locator('[data-tour="settings"]').isVisible()).toBe(true);

  await page.getByRole("button", { name: "Next" }).click();
  await expect
    .poll(() =>
      page
        .getByRole("heading", { name: "Settings: manage your workspace and connections" })
        .isVisible(),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.locator(".tour-next").evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= globalThis.innerHeight;
      }),
    )
    .toBe(true);
  await expect.poll(() => page.locator(".settings-sidebar").isVisible()).toBe(true);
  const settingsSidebar = page.locator(".settings-sidebar");
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toBe("/platformclaw/app/settings/appearance");
  await expect
    .poll(() => page.getByText("Administrators register MCP servers", { exact: false }).isVisible())
    .toBe(true);

  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect.poll(() => page.locator('[data-tour="settings"]').isVisible()).toBe(true);
  await expect.poll(() => page.locator(".tour-highlight").isVisible()).toBe(true);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect.poll(() => page.locator(".settings-sidebar").isVisible()).toBe(true);
  await expect.poll(() => page.locator(".tour-progress").textContent()).toContain("14 of 22");

  await page.getByRole("button", { name: "Next" }).click();
  await expect
    .poll(() =>
      page.getByRole("heading", { name: "Memory: open your knowledge workspace" }).isVisible(),
    )
    .toBe(true);

  const memoryGuideSteps = [
    [
      "Memory: five views for retained knowledge",
      "05f-02-memory-overview-guide.png",
      "/platformclaw/app/settings/memory",
    ],
    [
      "Memory: search personal recall",
      "05f-03-personal-memory-guide.png",
      "/platformclaw/app/settings/memory/memories",
    ],
    [
      "Personal Wiki: review reusable source pages",
      "05f-04-personal-wiki-guide.png",
      "/platformclaw/app/settings/memory/wiki",
    ],
    [
      "Organization: promote personal knowledge to your Part",
      "05f-05-promotion-guide.png",
      "/platformclaw/app/settings/memory/organization",
    ],
    [
      "Dreaming: inspect memory consolidation",
      "05f-06-dreaming-guide.png",
      "/platformclaw/app/settings/memory/dreams",
    ],
  ] as const;
  let previousTabLeft = -1;
  for (const [index, [heading, screenshot, pathname]] of memoryGuideSteps.entries()) {
    const nextButton = page.getByRole("button", { name: "Next" });
    await expect
      .poll(async () => (await nextButton.isVisible()) && (await nextButton.isEnabled()))
      .toBe(true);
    await nextButton.click();
    await expect.poll(() => page.getByRole("heading", { name: heading }).isVisible()).toBe(true);
    await expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
    await expect.poll(() => page.locator(".tour-highlight").isVisible()).toBe(true);
    await expect.poll(() => page.locator(".tour-next").isEnabled()).toBe(true);
    const tab = page.locator(".platformclaw-memory-page__tabs [role=tab]").nth(index);
    const tabBox = await tab.boundingBox();
    expect(tabBox).not.toBeNull();
    expect(tabBox!.x).toBeGreaterThan(previousTabLeft);
    previousTabLeft = tabBox!.x;
    if (heading.startsWith("Dreaming:")) {
      await expect
        .poll(() =>
          page.locator("#platformclaw-memory-tab-dreaming").evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < globalThis.innerHeight &&
              rect.left < globalThis.innerWidth
            );
          }),
        )
        .toBe(true);
    }
    if (heading.startsWith("Organization:")) {
      await expect
        .poll(() => page.getByText("Only an approved request", { exact: false }).isVisible())
        .toBe(true);
    }
    if (captureUiProofEnabled) {
      await page.screenshot({ fullPage: true, path: path.join(proofDir, screenshot) });
    }
  }

  await page.getByRole("button", { name: "Next" }).click();
  await expect
    .poll(() =>
      page.getByRole("heading", { name: "Organization: review membership and access" }).isVisible(),
    )
    .toBe(true);
  const organizationLink = settingsSidebar.getByRole("link", { name: "Organization", exact: true });
  await expect.poll(() => organizationLink.isVisible()).toBe(true);
  expect(
    await organizationLink.evaluate((element) => {
      const memory = document.querySelector('.settings-sidebar__item[href$="/settings/memory"]');
      return Boolean(
        memory && memory.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
  ).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/platformclaw/app/settings/memory/dreams");

  await page.getByRole("button", { name: "Next" }).click();
  await expect
    .poll(() => page.getByRole("heading", { name: "You are back Home" }).isVisible())
    .toBe(true);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/chat/person_one");
  await expect
    .poll(() => quickActions.getByRole("button", { name: "Guide" }).isVisible())
    .toBe(true);

  // Going back restores the settings item first, then the final Memory tab.
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect
    .poll(() =>
      page.getByRole("heading", { name: "Organization: review membership and access" }).isVisible(),
    )
    .toBe(true);
  await expect.poll(() => page.locator(".tour-progress").textContent()).toContain("21 of 22");
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toBe("/platformclaw/app/settings/memory/dreams");
  await expect.poll(() => page.locator(".tour-highlight").isVisible()).toBe(true);
  await expect.poll(() => page.locator(".tour-progress").textContent()).toContain("20 of 22");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect
    .poll(() =>
      page.getByRole("heading", { name: "Organization: review membership and access" }).isVisible(),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/chat/person_one");

  await page.getByRole("button", { name: "Done" }).click();
  await expect.poll(() => page.locator(".tour-popover").count()).toBe(0);
  expect(
    await page.evaluate(() => localStorage.getItem("platformclaw.product-tour.v1.completed")),
  ).toBe("true");

  await expect
    .poll(() => quickActions.getByRole("button", { name: "Guide" }).isVisible())
    .toBe(true);
  await expect.poll(() => page.locator(".tour-popover").count()).toBe(0);
  await quickActions.getByRole("button", { name: "Guide" }).click();
  await expect.poll(() => page.locator(".tour-popover").isVisible()).toBe(true);
  await page.keyboard.press("Escape");
  await page.goto(new URL("/platformclaw/app/settings/appearance", page.url()).href);
  await quickActions.getByRole("button", { name: "Guide" }).click();
  await expect.poll(() => page.locator(".tour-popover").isVisible()).toBe(true);
  await page.keyboard.press("Tab");
  expect(await page.locator(".tour-close").evaluate((button) => button.matches(":focus"))).toBe(
    true,
  );
  await page.keyboard.press("Shift+Tab");
  expect(await page.locator(".tour-next").evaluate((button) => button.matches(":focus"))).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await expect.poll(() => page.locator(".tour-popover").count()).toBe(0);
  expect(new URL(page.url()).pathname).toBe("/platformclaw/app/settings/appearance");
}
