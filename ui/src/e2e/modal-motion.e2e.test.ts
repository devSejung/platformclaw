import { expect, it } from "vitest";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
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
  async function setup(
    reducedMotion: "reduce" | "no-preference" = "no-preference",
    deferDocument = false,
  ) {
    const context = await suite.newBrowserContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion,
    });
    const page = await context.newPage();
    await installPlatformClawMemoryDocument(page, suite.server.baseUrl);
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: platformClawMemoryAgentId,
      featureMethods: [...platformClawMemoryMethods],
      methodResponses: platformClawMemoryResponses,
      deferredMethods: deferDocument ? ["platformclaw.vault.document.get"] : [],
    });
    await page.goto(`${suite.server.baseUrl}platformclaw/app/settings/memory/vaults`);
    await page.getByRole("button", { name: "Ulysses PHY Spec", exact: true }).click();
    const open = page.getByRole("button", { name: "Training sequence", exact: true });
    await open.waitFor();
    const transitions = await page.evaluateHandle(() => {
      const properties: string[] = [];
      const observedBodies = new WeakSet<Element>();
      const sourceDialog = (event: Event) => {
        const source = event.composedPath()[0];
        return source instanceof HTMLElement && source.localName === "wa-dialog" ? source : null;
      };
      document.addEventListener("wa-show", (event) => {
        const body = sourceDialog(event)?.shadowRoot?.querySelector('[part="body"]');
        // Nested overlays share lifecycle names; retained dialogs must keep one recorder.
        if (!body || observedBodies.has(body)) {
          return;
        }
        observedBodies.add(body);
        body.addEventListener("transitionrun", (transition) => {
          const property = (transition as TransitionEvent).propertyName;
          if (transition.target === body && ["opacity", "transform"].includes(property)) {
            properties.push(property);
          }
        });
      });
      document.addEventListener("wa-after-show", (event) => {
        const root = sourceDialog(event)?.getRootNode();
        const modal = root instanceof ShadowRoot ? root.host : null;
        if (modal instanceof HTMLElement && modal.localName === "openclaw-modal-dialog") {
          modal.dataset.afterShow = String(Number(modal.dataset.afterShow ?? 0) + 1);
        }
      });
      return properties;
    });
    return { page, open, transitions, gateway };
  }

  it.each([false, true])(
    "bridges a real document reader (deferred: %s) while preserving immediate actions and focus restoration",
    async (deferDocument) => {
      const { page, open, transitions, gateway } = await setup("no-preference", deferDocument);
      await open.click();
      const modal = page.locator("openclaw-modal-dialog");
      const dialog = modal.locator("dialog");
      const body = modal.locator('[part="body"]');
      if (deferDocument) {
        await expect.poll(() => modal.getAttribute("data-after-show")).toBe("1");
        const initialModal = await modal.elementHandle();
        await modal.locator(".vaults__heading button").focus();
        await gateway.resolveDeferred("platformclaw.vault.document.get");
        await modal.locator("[data-vault-document]").waitFor();
        expect(
          await modal
            .locator(".wiki-document__actions button")
            .last()
            .evaluate((button) => button === document.activeElement),
        ).toBe(true);
        expect(
          await modal.evaluate((current, original) => current === original, initialModal),
        ).toBe(true);
      }
      await expect
        .poll(async () => (await transitions.jsonValue()).sort())
        .toEqual(["opacity", "transform"]);
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
    },
  );

  it.each(["Escape", "backdrop"] as const)(
    "keeps the reader open when %s cancels deletion",
    async (dismissal) => {
      const { page, open, transitions } = await setup();
      await open.click();
      const modal = page.locator("openclaw-modal-dialog");
      const dialog = modal.locator("dialog");
      await modal.locator("[data-vault-document]").waitFor();
      await expect.poll(() => modal.getAttribute("data-after-show")).toBe("1");
      const original = await modal.elementHandle();
      await modal.locator(".wiki-document__actions button.danger").click();
      await modal.locator(".vaults__dialog").waitFor();
      if (dismissal === "Escape") {
        await page.keyboard.press("Escape");
      } else {
        await page.mouse.click(4, 4);
      }
      await modal.locator("[data-vault-document]").waitFor();
      expect(await modal.evaluate((current, initial) => current === initial, original)).toBe(true);
      expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
      await expect.poll(() => modal.getAttribute("data-after-show")).toBe("1");
      expect((await transitions.jsonValue()).toSorted()).toEqual(["opacity", "transform"]);
      const close = modal.locator(".wiki-document__actions button").last();
      expect(await close.isVisible()).toBe(true);
      await close.click();
      await modal.waitFor({ state: "detached" });
      await expect
        .poll(() => open.evaluate((element) => element === document.activeElement))
        .toBe(true);
    },
  );

  it("moves a right-edge drawer horizontally and keeps command surfaces instant", async () => {
    const { page, transitions } = await setup();
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
      await expect.poll(() => modal.getAttribute("data-after-show")).toBe("1");
      if (kind === "drawer") {
        expect(await modal.getAttribute("data-pointer-motion")).not.toBeNull();
        expect(await body.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
          "0.18s, 0.18s",
        );
        // The translated surface must remain full-size; the old modal zoom scaled this drawer.
        expect(
          await body.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
        ).toBe(1);
        await expect
          .poll(async () => (await transitions.jsonValue()).sort())
          .toEqual(["opacity", "transform"]);
        // Child lifecycle events must neither reattach the recorder nor count as dialog shows.
        await modal.locator("button").evaluate((button) => {
          for (const name of ["wa-show", "wa-after-show"]) {
            button.dispatchEvent(new Event(name, { bubbles: true, composed: true }));
          }
        });
        expect(await modal.getAttribute("data-after-show")).toBe("1");
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
      await expect
        .poll(async () => (await transitions.jsonValue()).sort())
        .toEqual(["opacity", "opacity", "transform", "transform"]);
      expect(await dialog.evaluate((element) => element.classList.contains("show"))).toBe(false);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await modal.evaluate((element) => element.remove());
      await trigger.evaluate((element) => element.remove());
    }
  });

  it.each(["owner", "Escape"] as const)(
    "honors a reopen during %s hide without losing modality, focus, or cancellation",
    async (source) => {
      const { page } = await setup();
      await page.evaluate(() => {
        const trigger = document.createElement("button");
        trigger.id = "reopen-trigger";
        trigger.textContent = "Open retained dialog";
        trigger.style.cssText = "position:fixed;top:12px;left:50%;z-index:9999";
        const modal = document.createElement("openclaw-modal-dialog");
        modal.id = "reopen-modal";
        modal.manual = true;
        modal.label = "Retained dialog";
        modal.innerHTML = '<input autofocus aria-label="Retained field" />';
        modal.dataset.cancels = "0";
        modal.addEventListener("modal-cancel", (event) => {
          modal.dataset.cancels = String(Number(modal.dataset.cancels) + 1);
          if (modal.dataset.preventCancel === "true") {
            event.preventDefault();
          } else {
            modal.hide();
          }
        });
        trigger.addEventListener("click", () => modal.show());
        document.body.append(trigger, modal);
      });
      const trigger = page.locator("#reopen-trigger");
      const modal = page.locator("#reopen-modal");
      const dialog = modal.locator("dialog");
      await trigger.click();
      await expect.poll(() => modal.getAttribute("data-after-show")).toBe("1");
      await modal.evaluate((element) => {
        element
          .shadowRoot!.querySelector("wa-dialog")!
          .addEventListener(
            "wa-hide",
            () => queueMicrotask(() => (element as OpenClawModalDialog).show()),
            { once: true },
          );
      });
      if (source === "owner") {
        await modal.evaluate((element) => (element as OpenClawModalDialog).hide());
      } else {
        await page.keyboard.press("Escape");
      }
      await expect.poll(() => modal.getAttribute("data-after-show")).toBe("2");
      expect(await modal.evaluate((element) => (element as OpenClawModalDialog).open)).toBe(true);
      expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
      const field = modal.getByRole("textbox", { name: "Retained field" });
      await expect
        .poll(() => field.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(await modal.getAttribute("data-cancels")).toBe(source === "owner" ? "0" : "1");
      await modal.evaluate((element) => {
        element.dataset.preventCancel = "true";
      });
      await page.keyboard.press("Escape");
      expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
      expect(await modal.evaluate((element) => (element as OpenClawModalDialog).open)).toBe(true);
      await modal.evaluate((element) => {
        element.dataset.preventCancel = "false";
      });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await expect
        .poll(() => trigger.evaluate((element) => element === document.activeElement))
        .toBe(true);
    },
  );

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
