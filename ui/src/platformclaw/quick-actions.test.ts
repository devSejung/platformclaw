import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
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

describe("platformclaw-quick-actions", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    localStorage.clear();
    await i18n.setLocale("en");
  });

  it("renders the compact role-aware grid and server-owned VOC action", async () => {
    localStorage.setItem(PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY, "true");
    const admin = await mount({ admin: true, vocEnabled: true });

    expect(admin.shadowRoot?.querySelector("platformclaw-execution-settings")).not.toBeNull();
    expect(admin.shadowRoot?.querySelector("platformclaw-vm-administration")).not.toBeNull();
    admin.shadowRoot?.querySelector<HTMLButtonElement>('[data-tour="voc"]')?.click();
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

    await vi.waitFor(() => expect(member.shadowRoot?.textContent).toContain("가이드"));
    await vi.waitFor(() =>
      expect(
        member.shadowRoot?.querySelector("platformclaw-execution-settings")?.shadowRoot
          ?.textContent,
      ).toContain("VM 서버"),
    );
    await vi.waitFor(() =>
      expect(member.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
        "PlatformClaw에 오신 것을 환영합니다",
      ),
    );
    expect(member.shadowRoot?.querySelector(".tour-next")?.textContent?.trim()).toBe("다음");
  });

  it("starts automatically until the user completes or suppresses the versioned tour", async () => {
    const first = await mount();
    await vi.waitFor(() => expect(first.shadowRoot?.querySelector(".tour-popover")).not.toBeNull());

    first.shadowRoot?.querySelector<HTMLButtonElement>(".tour-never")?.click();
    await first.updateComplete;
    expect(localStorage.getItem(PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY)).toBe("true");
    expect(first.shadowRoot?.querySelector(".tour-popover")).toBeNull();

    first.remove();
    const completed = await mount();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(completed.shadowRoot?.querySelector(".tour-popover")).toBeNull();

    completed.shadowRoot?.querySelector<HTMLButtonElement>('[data-tour="guide"]')?.click();
    await vi.waitFor(() =>
      expect(completed.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );
  });

  it("records completion when the final step is done", async () => {
    const element = await mount();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );

    for (let index = 0; index < 7; index += 1) {
      element.shadowRoot?.querySelector<HTMLButtonElement>(".tour-next")?.click();
      await element.updateComplete;
    }

    expect(localStorage.getItem(PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY)).toBe("true");
    expect(element.shadowRoot?.querySelector(".tour-popover")).toBeNull();
  });
});
