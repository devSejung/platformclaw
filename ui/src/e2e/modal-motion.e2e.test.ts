import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  installPlatformClawMemoryDocument,
  platformClawMemoryAgentId,
  platformClawMemoryMethods,
  platformClawMemoryResponses,
} from "../test-helpers/platformclaw-memory-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Common modal motion",
  unavailableMessage: (path) => `Common modal motion requires Chromium: ${path}`,
  trackBrowserContexts: true,
});

suite.define(() => {
  async function setup(reducedMotion: "reduce" | "no-preference" = "no-preference") {
    const context = await suite.newBrowserContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion,
    });
    const page = await context.newPage();
    await installPlatformClawMemoryDocument(page, suite.server.baseUrl);
    await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: platformClawMemoryAgentId,
      featureMethods: [...platformClawMemoryMethods],
      methodResponses: platformClawMemoryResponses,
    });
    await page.goto(`${suite.server.baseUrl}platformclaw/app/settings/memory/vaults`);
    await page.getByRole("button", { name: "Ulysses PHY Spec", exact: true }).click();
    const open = page.getByRole("button", { name: "Training sequence", exact: true });
    await open.waitFor();
    const transitions = await page.evaluateHandle(() => {
      const properties: string[] = [];
      document.addEventListener("wa-show", (event) => {
        const wa = event
          .composedPath()
          .find((node) => node instanceof Element && node.localName === "wa-dialog") as
          | HTMLElement
          | undefined;
        wa?.shadowRoot?.querySelector("dialog")?.addEventListener("transitionrun", (transition) => {
          const target = transition.target as Element;
          const property = (transition as TransitionEvent).propertyName;
          if (
            target.getAttribute("part") === "body" &&
            ["opacity", "transform"].includes(property)
          ) {
            properties.push(property);
          }
        });
      });
      document.addEventListener("wa-after-show", (event) => {
        const modal = event
          .composedPath()
          .find((node) => node instanceof Element && node.localName === "openclaw-modal-dialog") as
          | HTMLElement
          | undefined;
        if (modal) {
          modal.dataset.afterShow = String(Number(modal.dataset.afterShow ?? 0) + 1);
        }
      });
      return properties;
    });
    return { page, open, transitions };
  }

  it("bridges a real document reader while preserving immediate actions and focus restoration", async () => {
    const { page, open, transitions } = await setup();
    await open.click();
    const modal = page.locator("openclaw-modal-dialog");
    const dialog = modal.locator("dialog");
    const body = modal.locator('[part="body"]');
    await expect.poll(() => transitions.jsonValue()).toEqual(["opacity", "transform"]);
    expect(await dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe(
      "none",
    );
    expect(await body.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
      "0.18s, 0.18s",
    );
    await expect.poll(() => modal.getAttribute("data-after-show")).toBe("1");
    expect(await dialog.evaluate((element) => element.classList.contains("show"))).toBe(false);
    const close = modal.locator(".wiki-document__actions button").last();
    expect(await close.isEnabled()).toBe(true);
    await close.click({ force: true });
    await modal.waitFor({ state: "detached" });
    await expect
      .poll(() => open.evaluate((element) => element === document.activeElement))
      .toBe(true);
  });

  it("moves a right-edge drawer horizontally and keeps command surfaces instant", async () => {
    const { page } = await setup();
    for (const kind of ["drawer", "palette", "nav-drawer"]) {
      await page.evaluate((className) => {
        const trigger = document.createElement("button");
        trigger.id = "motion-contract-trigger";
        trigger.textContent = "Open motion contract";
        trigger.style.cssText = "position:fixed;top:12px;left:50%;z-index:9999";
        trigger.addEventListener("click", () => {
          const retained = document.querySelector("openclaw-modal-dialog");
          if (retained) {
            retained.show();
            return;
          }
          const modal = document.createElement("openclaw-modal-dialog");
          modal.id = "motion-contract-modal";
          modal.className = className;
          modal.label = "Motion contract";
          modal.innerHTML = "<button autofocus>Immediate action</button>";
          modal.addEventListener("modal-cancel", () => modal.hide());
          document.body.append(modal);
        });
        document.body.append(trigger);
      }, kind);
      const trigger = page.locator("#motion-contract-trigger");
      await trigger.click();
      const modal = page.locator("openclaw-modal-dialog");
      const dialog = modal.locator("dialog");
      const body = modal.locator('[part="body"]');
      await dialog.waitFor();
      if (kind === "drawer") {
        expect(await modal.getAttribute("data-pointer-motion")).not.toBeNull();
        expect(await body.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
          "0.18s, 0.18s",
        );
        // The translated surface must remain full-size; the old modal zoom scaled this drawer.
        expect(
          await body.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
        ).toBe(1);
      } else {
        expect(await modal.getAttribute("data-pointer-motion")).toBeNull();
        expect(await dialog.evaluate((element) => element.getAnimations().length)).toBe(0);
      }
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await expect
        .poll(() => trigger.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await trigger.click();
      await dialog.waitFor({ state: "visible" });
      await expect.poll(() => modal.getAttribute("data-after-show")).toBe("2");
      expect(await dialog.evaluate((element) => element.classList.contains("show"))).toBe(false);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await modal.evaluate((element) => element.remove());
      await trigger.evaluate((element) => element.remove());
    }
  });

  it.each(["keyboard", "assistive", "reduced"] as const)(
    "keeps %s document activation instant",
    async (mode) => {
      const { page, open, transitions } = await setup(
        mode === "reduced" ? "reduce" : "no-preference",
      );
      if (mode === "keyboard") {
        await open.focus();
        await open.press("Enter");
      } else if (mode === "assistive") {
        await open.evaluate((element) => (element as HTMLButtonElement).click());
      } else {
        await open.click();
      }
      const dialog = page.locator("openclaw-modal-dialog dialog");
      const body = page.locator('openclaw-modal-dialog [part="body"]');
      await dialog.waitFor();
      expect(await body.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
        "0s",
      );
      expect(await dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe(
        "none",
      );
      expect(await transitions.jsonValue()).toEqual([]);
    },
  );
});
