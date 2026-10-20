import { expect, it } from "vitest";
import {
  finish,
  issue,
  server,
  setup,
  setupSpaceBrowserTests,
  space,
  suite,
} from "./platformclaw-spaces.e2e-helpers.ts";

suite("Spaces panel motion", () => {
  setupSpaceBrowserTests();

  it("bridges pointer-opened panels without delaying focus, editing or removal", async () => {
    const { context, page, gateway, name } = await setup("panel-motion-desktop");
    try {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(
        `${server.baseUrl}platformclaw/app/spaces?space=${space.id}&page=${issue.id}`,
      );
      const ui = page.locator("platformclaw-spaces-page");
      const members = ui.getByRole("button", { name: "Members and access", exact: true });
      const panel = ui.locator(".pc-space-panel");
      await members.waitFor();
      const entered = await page.evaluateHandle(() => {
        const properties: string[] = [];
        document
          .querySelector("platformclaw-spaces-page")!
          .addEventListener("transitionrun", (event) => {
            if ((event.target as HTMLElement).classList.contains("pc-space-panel")) {
              properties.push((event as TransitionEvent).propertyName);
              properties.sort();
            }
          });
        return properties;
      });
      await members.click();
      await expect.poll(() => entered.jsonValue()).toEqual(["opacity", "transform"]);
      expect(
        await panel.evaluate((element) => ({
          duration: getComputedStyle(element).transitionDuration,
          properties: getComputedStyle(element).transitionProperty,
          focused: element.contains(document.activeElement),
        })),
      ).toEqual({ duration: "0.18s, 0.18s", properties: "transform, opacity", focused: true });

      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
      expect(await members.evaluate((element) => document.activeElement === element)).toBe(true);

      await ui.getByRole("tab", { name: "Shared Notes", exact: true }).click();
      await ui.getByRole("button", { name: "Edit page", exact: true }).click();
      expect(await panel.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
        "0.18s, 0.18s",
      );
      await ui.getByLabel("Title", { exact: true }).fill("A draft stays editable immediately");
      expect(await ui.getByLabel("Title", { exact: true }).inputValue()).toBe(
        "A draft stays editable immediately",
      );
      await gateway.setOnline(false);
      await panel.waitFor({ state: "detached" });
      expect(await ui.locator(".pc-space-editor").count()).toBe(0);
    } finally {
      await finish(context, page, name);
    }
  });

  it("opens instantly for keyboard and assistive activation after pointer use", async () => {
    const { context, page, name } = await setup("panel-motion-keyboard");
    try {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(`${server.baseUrl}platformclaw/app/spaces?space=${space.id}`);
      const ui = page.locator("platformclaw-spaces-page");
      const members = ui.getByRole("button", { name: "Members and access", exact: true });
      const panel = ui.locator(".pc-space-panel");
      await members.click();
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
      await members.press("Enter");
      expect(await panel.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
        "0s",
      );
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
      await members.evaluate((element) => (element as HTMLButtonElement).click());
      expect(await panel.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
        "0s",
      );
    } finally {
      await finish(context, page, name);
    }
  });

  it.each([
    { width: 1440, reducedMotion: "reduce" as const },
    { width: 390, reducedMotion: "no-preference" as const },
  ])("keeps $width px / $reducedMotion panels instant", async ({ width, reducedMotion }) => {
    const { context, page, name } = await setup(`panel-motion-${width}-${reducedMotion}`, width);
    try {
      await page.emulateMedia({ reducedMotion });
      await page.goto(`${server.baseUrl}platformclaw/app/spaces?space=${space.id}`);
      const ui = page.locator("platformclaw-spaces-page");
      await ui.getByRole("button", { name: "Members and access", exact: true }).click();
      const duration = await ui
        .locator(".pc-space-panel")
        .evaluate((element) => getComputedStyle(element).transitionDuration);
      expect(Number.parseFloat(duration)).toBeLessThan(0.001);
    } finally {
      await finish(context, page, name);
    }
  });
});
