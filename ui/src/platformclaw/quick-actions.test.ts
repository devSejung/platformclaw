import type { Config, Driver, PopoverDOM } from "driver.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const driverMock = vi.hoisted(() => ({
  config: null as Config | null,
  destroy: vi.fn(),
  drive: vi.fn(),
}));

vi.mock("driver.js", () => ({
  driver: (config: Config): Driver => {
    driverMock.config = config;
    return {
      destroy: driverMock.destroy,
      drive: driverMock.drive,
    } as unknown as Driver;
  },
}));

import {
  PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY,
  PlatformClawQuickActionsElement,
} from "./quick-actions.ts";

async function mount(options: { admin?: boolean; vocUrl?: string | null } = {}) {
  const element = document.createElement(
    "platformclaw-quick-actions",
  ) as PlatformClawQuickActionsElement;
  element.admin = options.admin ?? false;
  element.vocUrl = options.vocUrl ?? null;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function popoverDom(): PopoverDOM {
  const footer = document.createElement("footer");
  return {
    wrapper: document.createElement("div"),
    arrow: document.createElement("div"),
    title: document.createElement("div"),
    description: document.createElement("div"),
    footer,
    progress: document.createElement("span"),
    previousButton: document.createElement("button"),
    nextButton: document.createElement("button"),
    closeButton: document.createElement("button"),
    footerButtons: document.createElement("span"),
  };
}

describe("platformclaw-quick-actions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    driverMock.config = null;
    driverMock.destroy.mockClear();
    driverMock.drive.mockClear();
  });

  it("renders the compact role-aware grid and bounded VOC link", async () => {
    localStorage.setItem(PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY, "true");
    const admin = await mount({
      admin: true,
      vocUrl: "https://voc.company.example/intake",
    });

    expect(admin.shadowRoot?.querySelector("platformclaw-execution-settings")).not.toBeNull();
    expect(admin.shadowRoot?.querySelector("platformclaw-vm-administration")).not.toBeNull();
    const voc = admin.shadowRoot?.querySelector<HTMLAnchorElement>('[data-tour="voc"]');
    expect(voc?.href).toBe("https://voc.company.example/intake");
    expect(voc?.target).toBe("_blank");
    expect(voc?.rel).toBe("noopener noreferrer");

    admin.remove();
    const member = await mount();
    expect(member.shadowRoot?.querySelector("platformclaw-vm-administration")).toBeNull();
    expect(member.shadowRoot?.querySelector('[data-tour="voc"]')).toBeNull();
  });

  it("starts automatically until the user completes or suppresses the versioned tour", async () => {
    await mount();
    await vi.waitFor(() => expect(driverMock.drive).toHaveBeenCalledOnce());

    const popover = popoverDom();
    driverMock.config?.onPopoverRender?.(popover, {} as never);
    const suppress = popover.footer.querySelector<HTMLButtonElement>(".platformclaw-tour-never");
    expect(suppress?.textContent).toBe("Don't show again");
    suppress?.click();
    expect(localStorage.getItem(PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY)).toBe("true");
    expect(driverMock.destroy).toHaveBeenCalledOnce();

    document.body.innerHTML = "";
    driverMock.drive.mockClear();
    const completed = await mount();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(driverMock.drive).not.toHaveBeenCalled();

    completed.shadowRoot?.querySelector<HTMLButtonElement>('[data-tour="guide"]')?.click();
    await vi.waitFor(() => expect(driverMock.drive).toHaveBeenCalledOnce());
  });

  it("records completion when the final step is done", async () => {
    await mount();
    await vi.waitFor(() => expect(driverMock.config).not.toBeNull());

    driverMock.config?.onDoneClick?.(undefined, {} as never, {} as never);
    expect(localStorage.getItem(PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY)).toBe("true");
    expect(driverMock.destroy).toHaveBeenCalledOnce();
  });
});
