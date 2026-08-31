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

  await page.getByRole("button", { name: "Next" }).click();
  await expect
    .poll(() =>
      page
        .getByRole("heading", { name: "Settings button: open all workspace settings" })
        .isVisible(),
    )
    .toBe(true);
  await expect.poll(() => page.url().endsWith("/skills/hub")).toBe(true);
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

  await page.getByRole("button", { name: "Next" }).click();
  await expect
    .poll(() =>
      page.getByRole("heading", { name: "Organization: review membership and access" }).isVisible(),
    )
    .toBe(true);
  await expect
    .poll(() =>
      settingsSidebar.getByRole("link", { name: "Organization", exact: true }).isVisible(),
    )
    .toBe(true);
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toBe("/platformclaw/app/settings/appearance");

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
  for (const [heading, screenshot, pathname] of memoryGuideSteps) {
    const nextButton = page.getByRole("button", { name: "Next" });
    await expect
      .poll(async () => (await nextButton.isVisible()) && (await nextButton.isEnabled()))
      .toBe(true);
    await nextButton.click();
    await expect.poll(() => page.getByRole("heading", { name: heading }).isVisible()).toBe(true);
    await expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
    await expect.poll(() => page.locator(".tour-highlight").isVisible()).toBe(true);
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
    .poll(() => page.getByRole("heading", { name: "You are back Home" }).isVisible())
    .toBe(true);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/chat/person_one");
  await expect
    .poll(() => quickActions.getByRole("button", { name: "Guide" }).isVisible())
    .toBe(true);

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
}
