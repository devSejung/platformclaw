import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installSkillHubFixture } from "./skill-hub-installation.e2e.test-helpers.ts";

const suite = createControlUiE2eSuite({
  name: "Skill Hub completion motion",
  unavailableMessage: (executablePath) => `Playwright Chromium unavailable at ${executablePath}`,
  trackBrowserContexts: true,
});

type CompletionTransition = {
  target: string | undefined;
  property: string;
  duration: number;
  easing: string;
  from: number | null;
  to: number | null;
};

declare global {
  interface Window {
    skillHubCompletionTransitions: CompletionTransition[];
  }
}

async function recordCompletionTransitions(page: Page) {
  await page.evaluate(() => {
    window.skillHubCompletionTransitions = [];
    document.addEventListener("transitionrun", (event) => {
      const element = event.target;
      if (
        !(element instanceof HTMLElement) ||
        !element.matches(".skill-hub-destination__completion")
      ) {
        return;
      }
      const animation = element
        .getAnimations()
        .find(
          (candidate) =>
            candidate instanceof CSSTransition &&
            candidate.transitionProperty === event.propertyName,
        );
      const effect = animation?.effect;
      if (!(effect instanceof KeyframeEffect)) {
        return;
      }
      const { duration, easing } = effect.getTiming();
      if (typeof duration !== "number" || typeof easing !== "string") {
        throw new Error("Expected CSS transition timing in milliseconds with easing.");
      }
      const frames = effect.getKeyframes();
      const value = (frame: ComputedKeyframe) => {
        if (event.propertyName === "opacity") {
          return Number(frame.opacity);
        }
        return typeof frame.transform === "string" ? new DOMMatrix(frame.transform).m42 : null;
      };
      window.skillHubCompletionTransitions.push({
        target: element.closest<HTMLElement>("[data-install-target]")?.dataset.installTarget,
        property: event.propertyName,
        duration,
        easing,
        from: frames[0] ? value(frames[0]) : null,
        to: frames.at(-1) ? value(frames.at(-1)!) : null,
      });
    });
  });
}

async function openInstallation(reducedMotion: "reduce" | "no-preference" = "no-preference") {
  const context = await suite.newBrowserContext({
    locale: "en-US",
    reducedMotion,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const fixture = await installSkillHubFixture(page, suite.server.baseUrl);
  await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
  await page.locator(".skill-hub-card", { hasText: "Release checklist" }).click();
  const basic = page.locator('[data-install-target="platform_server"]');
  const vm = page.locator('[data-install-target="assigned_vm"]');
  await expect.poll(() => basic.locator("button").first().isEnabled()).toBe(true);
  await expect.poll(() => vm.locator('[role="status"]').textContent()).toContain("2.3.0");
  await recordCompletionTransitions(page);
  return { ...fixture, page, basic, vm };
}

suite.define(() => {
  it("transitions only the confirmed destination, preserving inputs, live status and target identity", async () => {
    const { page, basic, vm } = await openInstallation();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen!: () => void;
    const requested = new Promise<void>((resolve) => {
      seen = resolve;
    });
    await page.route("**/platformclaw/api/skill-hub/skills/by-id/*/install", async (route) => {
      const body = route.request().postDataJSON() as {
        destination: string;
        slug: string;
        version: string;
      };
      if (body.destination !== "platform_server") {
        return route.fallback();
      }
      seen();
      await pending;
      return route.fulfill({
        json: {
          ok: true,
          target: body.destination,
          slug: "release-checklist",
          version: body.version,
        },
      });
    });
    const status = await basic.locator('[role="status"]').elementHandle();
    const unrelated = await vm.locator('[role="status"] span').elementHandle();
    await basic.locator("button").first().click();
    await requested;
    expect(await page.locator(".skill-hub-destination__completion").count()).toBe(0);
    await page.keyboard.press("Tab");
    release();
    await expect
      .poll(() => page.evaluate(() => window.skillHubCompletionTransitions.length))
      .toBe(2);
    const transitions = await page.evaluate(() => window.skillHubCompletionTransitions);
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "platform_server",
          property: "opacity",
          duration: 180,
          from: 0.85,
          to: 1,
        }),
        expect.objectContaining({
          target: "platform_server",
          property: "transform",
          duration: 180,
          from: 2,
          to: 0,
        }),
      ]),
    );
    expect(
      transitions.every((transition) => transition.easing === "cubic-bezier(0.16, 1, 0.3, 1)"),
    ).toBe(true);
    expect(
      await status?.evaluate(
        (element) =>
          element ===
          document.querySelector('[data-install-target="platform_server"] [role="status"]'),
      ),
    ).toBe(true);
    expect(
      await unrelated?.evaluate(
        (element) =>
          element ===
          document.querySelector('[data-install-target="assigned_vm"] [role="status"] span'),
      ),
    ).toBe(true);
    expect(await vm.locator(".skill-hub-destination__completion").count()).toBe(0);

    const completed = await basic.locator(".skill-hub-destination__completion").elementHandle();
    await page.locator('.skill-hub-detail input[type="radio"][value="1.4.0"]').check();
    expect(
      await completed?.evaluate(
        (element) =>
          element ===
          document.querySelector(
            '[data-install-target="platform_server"] .skill-hub-destination__completion',
          ),
      ),
    ).toBe(true);
    await vm.locator("button").first().click();
    const confirmation = page.locator(".skill-hub-version-change");
    await expect.poll(() => confirmation.isVisible()).toBe(true);
    expect(await page.evaluate(() => window.skillHubCompletionTransitions.length)).toBe(2);
    await confirmation
      .getByRole("button", { name: "Replace installed version", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.skillHubCompletionTransitions.length))
      .toBe(4);
    expect(
      (await page.evaluate(() => window.skillHubCompletionTransitions))
        .slice(2)
        .every((transition) => transition.target === "assigned_vm"),
    ).toBe(true);
    expect(await page.locator('.skill-hub-detail input[value="1.4.0"]').isChecked()).toBe(true);
    await page
      .locator(".skill-hub-detail")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.locator(".skill-hub-card", { hasText: "Incident guide" }).click();
    await expect.poll(() => basic.locator("button").first().isEnabled()).toBe(true);
    expect(await page.locator(".skill-hub-destination__completion").count()).toBe(0);
    expect(await page.evaluate(() => window.skillHubCompletionTransitions.length)).toBe(4);
  });

  it.each(["reduce", "keyboard", "programmatic"] as const)(
    "keeps %s completion instant",
    async (mode) => {
      const { page, basic } = await openInstallation(
        mode === "reduce" ? "reduce" : "no-preference",
      );
      const install = basic.locator("button").first();
      if (mode === "keyboard") {
        await install.focus();
        await page.keyboard.press("Enter");
      } else if (mode === "programmatic") {
        await install.evaluate((element: HTMLButtonElement) => element.click());
      } else {
        await install.click();
      }
      await expect.poll(() => basic.locator('[role="status"]').textContent()).toContain("2.3.0");
      expect(await basic.locator("button").first().isDisabled()).toBe(true);
      expect(
        await basic
          .locator('[role="status"]')
          .evaluate((element) => element.getAnimations({ subtree: true }).length),
      ).toBe(0);
      expect(await page.evaluate(() => window.skillHubCompletionTransitions)).toEqual([]);
      if (mode !== "reduce") {
        expect(await page.locator(".skill-hub-destination__completion").count()).toBe(0);
      }
    },
  );
});
