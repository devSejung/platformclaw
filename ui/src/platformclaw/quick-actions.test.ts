import type { Config, Driver, PopoverDOM } from "driver.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";

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

async function mount(options: { admin?: boolean; vocEnabled?: boolean } = {}) {
  const element = document.createElement(
    "platformclaw-quick-actions",
  ) as PlatformClawQuickActionsElement;
  element.admin = options.admin ?? false;
  element.vocEnabled = options.vocEnabled ?? false;
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
  beforeEach(async () => {
    document.body.innerHTML = "";
    localStorage.clear();
    await i18n.setLocale("en");
    driverMock.config = null;
    driverMock.destroy.mockClear();
    driverMock.drive.mockClear();
  });

  it("renders the compact role-aware grid and server-owned VOC action", async () => {
    localStorage.setItem(PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY, "true");
    const admin = await mount({
      admin: true,
      vocEnabled: true,
    });

    expect(admin.shadowRoot?.querySelector("platformclaw-execution-settings")).not.toBeNull();
    expect(admin.shadowRoot?.querySelector("platformclaw-vm-administration")).not.toBeNull();
    const voc = admin.shadowRoot?.querySelector<HTMLButtonElement>('[data-tour="voc"]');
    voc?.click();
    await admin.updateComplete;
    expect(admin.shadowRoot?.querySelector("platformclaw-voc-dialog")).not.toBeNull();
    const adminItems = [...(admin.shadowRoot?.querySelector(".grid")?.children ?? [])];
    expect(adminItems.map((item) => item.localName)).toEqual([
      "button",
      "button",
      "platformclaw-execution-settings",
      "platformclaw-vm-administration",
    ]);

    admin.remove();
    const member = await mount({ vocEnabled: true });
    expect(member.shadowRoot?.querySelector("platformclaw-vm-administration")).toBeNull();
    const memberExecution = member.shadowRoot?.querySelector("platformclaw-execution-settings");
    expect(memberExecution?.classList.contains("span-two")).toBe(true);
    expect(
      [...(member.shadowRoot?.querySelector(".grid")?.children ?? [])].map(
        (item) => item.localName,
      ),
    ).toEqual(["button", "button", "platformclaw-execution-settings"]);
  });

  it("uses the PlatformClaw-owned Korean quick actions and tour copy", async () => {
    await i18n.setLocale("ko");
    const member = await mount({ vocEnabled: true });

    await vi.waitFor(() => {
      expect(member.shadowRoot?.textContent).toContain("가이드");
      expect(
        member.shadowRoot?.querySelector("platformclaw-execution-settings")?.shadowRoot
          ?.textContent,
      ).toContain("VM 서버");
    });
    await vi.waitFor(() =>
      expect(driverMock.config?.steps?.[0]?.popover?.title).toBe(
        "PlatformClaw에 오신 것을 환영합니다",
      ),
    );
    expect(driverMock.config?.nextBtnText).toBe("다음");
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
