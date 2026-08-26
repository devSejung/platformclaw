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

async function advanceTour(element: PlatformClawQuickActionsElement) {
  const button = element.shadowRoot?.querySelector<HTMLButtonElement>(".tour-next");
  await vi.waitFor(() => expect(button?.disabled).toBe(false));
  const progress = element.shadowRoot?.querySelector(".tour-progress")?.textContent;
  button?.click();
  await vi.waitFor(() =>
    expect(element.shadowRoot?.querySelector(".tour-progress")?.textContent).not.toBe(progress),
  );
  await vi.waitFor(() => {
    const next = element.shadowRoot?.querySelector<HTMLButtonElement>(".tour-next");
    expect(next?.disabled ?? false).toBe(false);
  });
}

function installMemberPluginsHub(link: HTMLAnchorElement) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (document.querySelector(".plugins-hub-tabs-row")) {
      return;
    }
    const row = document.createElement("div");
    row.className = "plugins-hub-tabs-row";
    row.getBoundingClientRect = () => DOMRect.fromRect({ x: 190, y: 90, width: 430, height: 46 });
    for (const [index, tab] of ["skills", "workshop", "skill-hub"].entries()) {
      const element = document.createElement("button");
      element.id = `plugins-tab-${tab}`;
      element.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 200 + index * 130, y: 96, width: 120, height: 34 });
      row.append(element);
    }
    document.body.append(row);
  });
}

function installMemberSettings(button: HTMLButtonElement) {
  button.addEventListener("click", () => {
    if (document.querySelector(".settings-sidebar")) {
      return;
    }
    const settings = document.createElement("aside");
    settings.className = "settings-sidebar";
    settings.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: 280, height: 700 });
    const memoryLink = document.createElement("a");
    memoryLink.className = "settings-sidebar__item";
    memoryLink.href = "/settings/memory";
    memoryLink.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 20, y: 320, width: 220, height: 36 });
    memoryLink.addEventListener("click", (event) => {
      event.preventDefault();
      if (document.querySelector(".platformclaw-memory-page__tabs")) {
        return;
      }
      const tabs = document.createElement("nav");
      tabs.className = "platformclaw-memory-page__tabs";
      tabs.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 310, y: 90, width: 600, height: 48 });
      for (const [index, tab] of ["memory", "wiki", "organization", "dreaming"].entries()) {
        const tabElement = document.createElement("button");
        tabElement.id = `platformclaw-memory-tab-${tab}`;
        tabElement.getBoundingClientRect = () =>
          DOMRect.fromRect({ x: 320 + index * 135, y: 96, width: 125, height: 34 });
        tabs.append(tabElement);
      }
      document.body.append(tabs);
    });
    const organizationLink = document.createElement("a");
    organizationLink.className = "settings-sidebar__item";
    organizationLink.href = "/settings/organization";
    organizationLink.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 20, y: 360, width: 220, height: 36 });
    settings.append(memoryLink);
    settings.append(organizationLink);
    document.body.append(settings);
  });
}

describe("platformclaw-quick-actions", () => {
  beforeEach(async () => {
    for (const element of document.querySelectorAll("platformclaw-quick-actions")) {
      element.shadowRoot?.querySelector<HTMLButtonElement>(".tour-close")?.click();
    }
    document.body.innerHTML = "";
    const terminalButton = document.createElement("button");
    terminalButton.dataset.tour = "terminal";
    terminalButton.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 320, y: 640, width: 36, height: 36 });
    document.body.append(terminalButton);
    localStorage.clear();
    globalThis.history.replaceState(null, "", "/platformclaw/app/chat");
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
    expect(member.shadowRoot?.querySelector(".tour-progress")?.textContent?.trim()).toBe("1 / 24");
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
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
    expect(completed.shadowRoot?.querySelector(".tour-popover")).toBeNull();

    completed.shadowRoot?.querySelector<HTMLButtonElement>('[data-tour="guide"]')?.click();
    await vi.waitFor(() =>
      expect(completed.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );
  });

  it("waits for a manual launch outside the chat route", async () => {
    globalThis.history.replaceState(null, "", "/platformclaw/app/settings/appearance");
    const element = await mount();
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });

    expect(element.shadowRoot?.querySelector(".tour-popover")).toBeNull();
    element.shadowRoot?.querySelector<HTMLButtonElement>('[data-tour="guide"]')?.click();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );
  });

  it("records completion when the final step is done", async () => {
    const element = await mount();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );

    for (let index = 0; index < 24; index += 1) {
      await advanceTour(element);
    }

    expect(localStorage.getItem(PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY)).toBe("true");
    expect(element.shadowRoot?.querySelector(".tour-popover")).toBeNull();
  });

  it("opens Settings and explains the Memory workflow in sequence", async () => {
    const sidebar = document.createElement("openclaw-app-sidebar");
    const settingsButton = document.createElement("button");
    settingsButton.className = "sidebar-footer-bar__settings";
    settingsButton.dataset.tour = "settings";
    settingsButton.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 20, y: 360, width: 140, height: 36 });
    installMemberSettings(settingsButton);
    sidebar.append(settingsButton);
    document.body.append(sidebar);
    const element = await mount();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );

    for (let index = 0; index < 14; index += 1) {
      await advanceTour(element);
    }

    expect(document.querySelector(".settings-sidebar")).toBeNull();
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Settings button: open all workspace settings",
    );
    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Settings: manage your workspace and connections",
    );
    expect(element.shadowRoot?.querySelector(".tour-popover")?.textContent).toContain(
      "Agents & tools contains Agents, Labs, model providers, MCP, Memory, Organization, and Automation",
    );
    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Organization: review membership and access",
    );
    expect(element.shadowRoot?.querySelector(".tour-popover")?.textContent).toContain(
      "separate from the Organization knowledge-promotion tab inside Memory",
    );
    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Memory: open your knowledge workspace",
    );
    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Memory: five views for retained knowledge",
    );
    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Memory: search personal recall",
    );
  });

  it("keeps the target clear and explains the plugin workflow step by step", async () => {
    const sidebar = document.createElement("openclaw-app-sidebar");
    const pluginsLink = document.createElement("a");
    pluginsLink.className = "nav-item";
    pluginsLink.href = "/skills";
    pluginsLink.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 20, y: 120, width: 140, height: 36 });
    installMemberPluginsHub(pluginsLink);
    sidebar.append(pluginsLink);
    document.body.append(sidebar);
    const element = await mount();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );

    for (let index = 0; index < 10; index += 1) {
      await advanceTour(element);
    }

    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Understand the Plugins hub",
    );
    expect(element.shadowRoot?.querySelectorAll(".tour-popover li")).toHaveLength(5);
    expect(element.shadowRoot?.querySelector(".tour-target-label")?.textContent).toBe("LOOK HERE");
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelectorAll(".tour-shade")).toHaveLength(4),
    );

    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Skills: instructions your Agent can reuse",
    );
    expect(element.shadowRoot?.querySelector(".tour-popover")?.textContent).toContain(
      "Needs Setup shows missing requirements",
    );
    expect(element.shadowRoot?.querySelector(".tour-highlight")?.getAttribute("style")).toContain(
      "left:193px",
    );
  });

  it("restores the same guide step when navigation changes optional steps", async () => {
    const sidebar = document.createElement("openclaw-app-sidebar");
    const pluginsLink = document.createElement("a");
    pluginsLink.className = "nav-item";
    pluginsLink.href = "/settings/plugins";
    installMemberPluginsHub(pluginsLink);
    const settingsButton = document.createElement("button");
    settingsButton.dataset.tour = "settings";
    installMemberSettings(settingsButton);
    sidebar.append(pluginsLink, settingsButton);
    document.body.append(sidebar);

    const beforeNavigation = await mount();
    await vi.waitFor(() =>
      expect(beforeNavigation.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );
    for (let index = 0; index < 16; index += 1) {
      await advanceTour(beforeNavigation);
    }
    expect(beforeNavigation.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Settings button: open all workspace settings",
    );

    beforeNavigation.remove();
    pluginsLink.remove();
    const afterNavigation = await mount();
    await vi.waitFor(() =>
      expect(afterNavigation.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
        "Settings button: open all workspace settings",
      ),
    );
    await advanceTour(afterNavigation);
    await advanceTour(afterNavigation);
    expect(afterNavigation.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Organization: review membership and access",
    );

    afterNavigation.remove();
    document.body.append(beforeNavigation);
    await vi.waitFor(() =>
      expect(beforeNavigation.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
        "Organization: review membership and access",
      ),
    );

    beforeNavigation.remove();
    document.querySelector(".settings-sidebar")?.remove();
    document.body.append(beforeNavigation);
    await beforeNavigation.updateComplete;
    expect(beforeNavigation.shadowRoot?.querySelector(".tour-popover")).toBeNull();

    settingsButton.click();
    const validSettingsInstance = await mount();
    await vi.waitFor(() =>
      expect(validSettingsInstance.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
        "Organization: review membership and access",
      ),
    );
    validSettingsInstance.shadowRoot?.querySelector<HTMLButtonElement>(".tour-close")?.click();
  });
});
