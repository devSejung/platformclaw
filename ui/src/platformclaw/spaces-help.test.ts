import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import { mount, page, setupSpacePageTests } from "./spaces-page.test-support.ts";
import "./page-help.ts";

setupSpacePageTests();

describe("Space heading help", () => {
  it("renders the product accessory beside the unchanged overview and detail headings", async () => {
    const { element, gateway } = await mount();
    const renderPageHeaderAccessory = vi.fn(
      (routeId: string) => html`
        <platformclaw-page-help-trigger .routeId=${routeId}></platformclaw-page-help-trigger>
      `,
    );
    element.context = {
      ...(element.context as Record<string, unknown>),
      renderPageHeaderAccessory,
    };
    element.requestUpdate();
    await element.updateComplete;
    const assertHeading = async (title: string) => {
      const heading = element.querySelector(".pc-space-heading h1");
      expect(heading?.textContent).toBe(title);
      expect(element.querySelectorAll("platformclaw-page-help-trigger")).toHaveLength(1);
      const trigger = element.querySelector("platformclaw-page-help-trigger")!;
      expect(heading?.nextElementSibling).toBe(trigger);
      await trigger.updateComplete;
      expect(trigger.routeId).toBe("spaces");
      expect(trigger.shadowRoot?.querySelector("button")?.ariaLabel).toBe("Help for Spaces");
    };
    await assertHeading(page.title);
    gateway.snapshot.phase = "reconnecting";
    element.requestUpdate();
    await vi.waitFor(() =>
      expect(element.querySelector(".pc-space-heading h1")?.textContent).toBe("Spaces"),
    );
    await assertHeading("Spaces");
    expect(renderPageHeaderAccessory).toHaveBeenCalledWith("spaces");
  });
});
