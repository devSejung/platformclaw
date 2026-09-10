import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { installBrowserHistoryIsolation } from "../test-helpers/browser-history.ts";
import {
  PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY,
  PlatformClawQuickActionsElement,
} from "./quick-actions.ts";

installBrowserHistoryIsolation();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

const BASIC_EXECUTION_SETTINGS = {
  activeTarget: "platform_server",
  targetRevision: 4,
  credentialStatus: "current",
  accountId: "person.one",
  availableVms: [],
};

function installMobileNavMediaQuery(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    matches,
    addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    setMatches(nextMatches: boolean) {
      this.matches = nextMatches;
      const event = { matches: nextMatches } as MediaQueryListEvent;
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mediaQuery),
  );
  return mediaQuery;
}

async function mount(
  options: { admin?: boolean; fetchImpl?: typeof fetch; vocEnabled?: boolean } = {},
) {
  const element = document.createElement(
    "platformclaw-quick-actions",
  ) as PlatformClawQuickActionsElement;
  element.admin = options.admin ?? false;
  if (options.fetchImpl) {
    element.fetchImpl = options.fetchImpl;
  }
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
    if (link.href.endsWith("/skills")) {
      globalThis.history.replaceState(null, "", "/skills");
    }
    if (link.href.endsWith("/settings/plugins")) {
      globalThis.history.replaceState(null, "", "/settings/plugins");
      for (const tab of ["installed", "discover"]) {
        const button = document.createElement("button");
        button.id = `plugins-tab-${tab}`;
        button.getBoundingClientRect = () =>
          DOMRect.fromRect({ x: 320, y: 150, width: 140, height: 36 });
        document.body.append(button);
      }
    }
    if (document.querySelector(".plugins-content-header")) {
      return;
    }
    const header = document.createElement("section");
    header.className = "plugins-content-header";
    header.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 320, y: 90, width: 600, height: 56 });
    document.body.append(header);
  });
  for (const [index, href] of ["/skills", "/skills/workshop", "/skills/hub"].entries()) {
    const destination = document.createElement("a");
    destination.className = "nav-item";
    destination.href = href;
    destination.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 20, y: 120 + index * 40, width: 180, height: 36 });
    destination.addEventListener("click", (event) => {
      event.preventDefault();
      globalThis.history.replaceState(null, "", href);
      document.querySelector(".plugins-content-header")?.remove();
      const header = document.createElement("section");
      header.className = "plugins-content-header";
      header.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 320, y: 90, width: 600, height: 56 });
      document.body.append(header);
    });
    (link.parentElement ?? document.body).append(destination);
  }
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
      for (const [index, tab] of [
        "overview",
        "memory",
        "wiki",
        "organization",
        "dreaming",
      ].entries()) {
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

  afterEach(() => {
    vi.unstubAllGlobals();
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
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(BASIC_EXECUTION_SETTINGS));
    const member = await mount({ fetchImpl, vocEnabled: true });

    await vi.waitFor(() => expect(member.shadowRoot?.textContent).toContain("가이드"));
    await vi.waitFor(() =>
      expect(
        member.shadowRoot?.querySelector("platformclaw-execution-settings")?.shadowRoot
          ?.textContent,
      ).toContain("기본 작업 공간"),
    );
    await vi.waitFor(() =>
      expect(member.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
        "PlatformClaw에 오신 것을 환영합니다",
      ),
    );
    expect(member.shadowRoot?.querySelector(".tour-next")?.textContent?.trim()).toBe("다음");
    expect(member.shadowRoot?.querySelector(".tour-progress")?.textContent?.trim()).toBe("1 / 22");
  });

  it("updates the quick-action label after changing work location", async () => {
    localStorage.setItem(PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY, "true");
    const vmSettings = {
      ...BASIC_EXECUTION_SETTINGS,
      activeTarget: "assigned_vm",
      targetRevision: 3,
      assignment: {
        vmHostId: "vm-one",
        status: "ready",
        vmLabel: "Development VM",
        safeConnectLabel: "SafeConnect",
        linuxAccount: "person.one",
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(vmSettings))
      .mockResolvedValueOnce(jsonResponse(BASIC_EXECUTION_SETTINGS));
    const member = await mount({ fetchImpl });
    const settings = member.shadowRoot?.querySelector("platformclaw-execution-settings");

    await vi.waitFor(() =>
      expect(settings?.shadowRoot?.textContent).toContain("My development VM"),
    );
    settings?.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    settings?.shadowRoot?.querySelector<HTMLElement>("[data-target='platform_server']")?.click();
    settings?.shadowRoot?.querySelector<HTMLElement>("[data-action='confirm-switch']")?.click();

    await vi.waitFor(() => expect(settings?.shadowRoot?.textContent).toContain("Basic workspace"));
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/platformclaw/api/execution/target",
      expect.objectContaining({
        body: JSON.stringify({ target: "platform_server", expectedRevision: 3 }),
        method: "POST",
      }),
    );
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

  it("does not advertise the PC-only guide in mobile navigation", async () => {
    const mediaQuery = installMobileNavMediaQuery(false);
    const element = await mount();
    expect(element.shadowRoot?.querySelector('[data-tour="guide"]')).not.toBeNull();

    mediaQuery.setMatches(true);
    await element.updateComplete;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    expect(element.shadowRoot?.querySelector(".tour-popover")).toBeNull();
    expect(element.shadowRoot?.querySelector('[data-tour="guide"]')).toBeNull();

    mediaQuery.setMatches(false);
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector('[data-tour="guide"]')).not.toBeNull();
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

  it("waits for gateway capabilities before freezing the first-run guide", async () => {
    document.querySelector('[data-tour="terminal"]')?.remove();
    let snapshot = { phase: "connecting", hello: null } as ApplicationGatewaySnapshot;
    const listeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
    const context = {
      gateway: {
        get snapshot() {
          return snapshot;
        },
        subscribe(listener: (value: ApplicationGatewaySnapshot) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      config: { current: { terminalEnabled: true } },
    } as unknown as ApplicationContext<RouteId>;
    const provider = createApplicationContextProvider(context);
    const element = document.createElement(
      "platformclaw-quick-actions",
    ) as PlatformClawQuickActionsElement;
    element.fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(BASIC_EXECUTION_SETTINGS));
    document.body.append(provider);
    provider.append(element);
    await element.updateComplete;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(element.shadowRoot?.querySelector(".tour-popover")).toBeNull();

    snapshot = {
      ...snapshot,
      phase: "connected",
      hello: {
        features: {
          methods: ["terminal.open"],
          capabilities: ["platformclaw.personal-vm-terminal"],
        },
      },
    } as ApplicationGatewaySnapshot;
    for (const listener of listeners) {
      listener(snapshot);
    }
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".tour-progress")?.textContent?.trim()).toBe(
        "1 of 22",
      ),
    );
    // The terminal button has not rendered yet; hello, not DOM timing, owns inclusion.
    expect(document.querySelector('[data-tour="terminal"]')).toBeNull();
    element.shadowRoot?.querySelector<HTMLButtonElement>(".tour-close")?.click();
    element.remove();
    expect(listeners.size).toBe(0);
  });

  it("keeps the step count stable when the terminal leaves the current screen", async () => {
    const element = await mount();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".tour-progress")?.textContent?.trim()).toBe(
        "1 of 22",
      ),
    );
    document.querySelector('[data-tour="terminal"]')?.remove();
    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-progress")?.textContent?.trim()).toBe(
      "2 of 22",
    );
  });

  it("keeps keyboard focus inside the tour and returns it to Guide on Escape", async () => {
    const element = await mount();
    const root = element.shadowRoot!;
    await vi.waitFor(() => expect(root.querySelector(".tour-next")).not.toBeNull());
    await vi.waitFor(() => expect(root.activeElement).toBe(root.querySelector(".tour-next")));
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    globalThis.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(root.querySelector(".tour-close"));
    globalThis.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }),
    );
    expect(root.activeElement).toBe(root.querySelector(".tour-next"));
    globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await element.updateComplete;
    expect(root.querySelector(".tour-popover")).toBeNull();
    expect(root.activeElement).toBe(root.querySelector('[data-tour="guide"]'));
  });

  it("omits the Terminal guide step when the capability is unavailable", async () => {
    document.querySelector('[data-tour="terminal"]')?.remove();
    const element = await mount();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );

    const next = element.shadowRoot?.querySelector<HTMLButtonElement>(".tour-next");
    next?.click();
    await new Promise<void>((resolve) => {
      globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve()));
    });
    await element.updateComplete;
    expect(next?.disabled).toBe(false);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Home: start a conversation with your Agent",
    );
    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Usage: understand tokens and cost",
    );
    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Tasks: follow assigned work",
    );
    expect(element.shadowRoot?.querySelector(".tour-progress")?.textContent?.trim()).toBe(
      "4 of 21",
    );
  });

  it("records completion when the final step is done", async () => {
    const element = await mount();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );

    for (let index = 0; index < 22; index += 1) {
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

    for (let index = 0; index < 12; index += 1) {
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
      "Only options available to your account are shown",
    );
    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Memory: open your knowledge workspace",
    );
    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Memory: five views for retained knowledge",
    );
    const personalMemoryTab = document.querySelector<HTMLElement>(
      "#platformclaw-memory-tab-memory",
    );
    const personalMemoryRect = vi
      .fn<() => DOMRect>()
      .mockReturnValueOnce(DOMRect.fromRect())
      .mockReturnValueOnce(DOMRect.fromRect())
      .mockReturnValue(DOMRect.fromRect({ x: 320, y: 96, width: 125, height: 34 }));
    if (personalMemoryTab) {
      personalMemoryTab.getBoundingClientRect = personalMemoryRect;
    }
    await advanceTour(element);
    expect(personalMemoryRect.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Memory: search personal recall",
    );
  });

  it("explains Skills, Workshop, and Skill Hub in sidebar order without leaving Home", async () => {
    const sidebar = document.createElement("openclaw-app-sidebar");
    const pluginsLink = document.createElement("a");
    pluginsLink.className = "nav-item";
    pluginsLink.href = "/skills";
    pluginsLink.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 20, y: 120, width: 140, height: 36 });
    sidebar.append(pluginsLink);
    installMemberPluginsHub(pluginsLink);
    document.body.append(sidebar);
    const element = await mount();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );

    for (let index = 0; index < 7; index += 1) {
      await advanceTour(element);
    }

    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Skills: instructions your Agent can reuse",
    );
    expect(element.shadowRoot?.querySelectorAll(".tour-popover li")).toHaveLength(3);
    expect(element.shadowRoot?.querySelector(".tour-target-label")?.textContent).toBe("LOOK HERE");
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelectorAll(".tour-shade")).toHaveLength(4),
    );

    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Workshop: review skill changes safely",
    );
    expect(element.shadowRoot?.querySelector(".tour-popover")?.textContent).toContain(
      "Draft skill changes stay separate from live skills",
    );
    expect(element.shadowRoot?.querySelector(".tour-highlight")?.getAttribute("style")).toContain(
      "left:13px",
    );

    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Skill Hub: install and share company skills",
    );
    expect(globalThis.location.pathname).toBe("/platformclaw/app/chat");
    expect(document.querySelector(".plugins-content-header")).toBeNull();

    await advanceTour(element);
    expect(element.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Choose where work runs",
    );
  });

  it("restores the same guide step when navigation changes optional steps", async () => {
    const sidebar = document.createElement("openclaw-app-sidebar");
    const pluginsLink = document.createElement("a");
    pluginsLink.className = "nav-item";
    pluginsLink.href = "/settings/plugins";
    const settingsButton = document.createElement("button");
    settingsButton.dataset.tour = "settings";
    let settingsButtonPosition: "visible" | "zero" = "visible";
    const settingsButtonRect = vi.fn(() =>
      DOMRect.fromRect(
        settingsButtonPosition === "visible" ? { x: 20, y: 360, width: 140, height: 36 } : {},
      ),
    );
    settingsButton.getBoundingClientRect = settingsButtonRect;
    settingsButton.scrollIntoView = vi.fn(() => {
      settingsButtonPosition = "visible";
    });
    installMemberSettings(settingsButton);
    sidebar.append(pluginsLink, settingsButton);
    document.body.append(sidebar);
    installMemberPluginsHub(pluginsLink);
    const beforeNavigation = await mount();
    await vi.waitFor(() =>
      expect(beforeNavigation.shadowRoot?.querySelector(".tour-popover")).not.toBeNull(),
    );
    for (let index = 0; index < 14; index += 1) {
      await advanceTour(beforeNavigation);
    }
    expect(beforeNavigation.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Settings button: open all workspace settings",
    );

    beforeNavigation.remove();
    pluginsLink.remove();
    settingsButtonPosition = "zero";
    const rectCallsBeforeRestore = settingsButtonRect.mock.calls.length;
    const addListener = vi.spyOn(globalThis, "addEventListener");
    const staleNavigation = await mount();
    await vi.waitFor(() =>
      expect(settingsButtonRect.mock.calls.length).toBeGreaterThan(rectCallsBeforeRestore),
    );
    staleNavigation.remove();
    await new Promise<void>((resolve) => {
      globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve()));
    });
    expect(addListener.mock.calls.some(([type]) => type === "keydown")).toBe(false);
    addListener.mockRestore();
    const replacementButton = document.createElement("button");
    replacementButton.dataset.tour = "settings";
    let replacementOffscreen = true;
    replacementButton.getBoundingClientRect = () =>
      DOMRect.fromRect({
        x: 20,
        y: replacementOffscreen ? 1200 : 360,
        width: 140,
        height: 36,
      });
    const replacementScrollIntoView = vi.fn(() => {
      replacementOffscreen = false;
    });
    replacementButton.scrollIntoView = replacementScrollIntoView;
    installMemberSettings(replacementButton);
    const afterNavigation = await mount();
    globalThis.requestAnimationFrame(() => {
      settingsButton.replaceWith(replacementButton);
    });
    await vi.waitFor(() =>
      expect(afterNavigation.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
        "Settings button: open all workspace settings",
      ),
    );
    expect(
      afterNavigation.shadowRoot?.querySelector(".tour-highlight")?.getAttribute("style"),
    ).not.toContain("display:none");
    expect(staleNavigation.shadowRoot?.querySelector(".tour-popover")).toBeNull();
    expect(replacementScrollIntoView).toHaveBeenCalled();
    await advanceTour(afterNavigation);
    await advanceTour(afterNavigation);
    expect(afterNavigation.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
      "Memory: open your knowledge workspace",
    );

    afterNavigation.remove();
    document.body.append(beforeNavigation);
    await vi.waitFor(() =>
      expect(beforeNavigation.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
        "Memory: open your knowledge workspace",
      ),
    );

    beforeNavigation.remove();
    document.querySelector(".settings-sidebar")?.remove();
    document.body.append(beforeNavigation);
    await beforeNavigation.updateComplete;
    expect(beforeNavigation.shadowRoot?.querySelector(".tour-popover")).toBeNull();

    replacementButton.click();
    const validSettingsInstance = await mount();
    await vi.waitFor(() =>
      expect(validSettingsInstance.shadowRoot?.querySelector(".tour-popover h2")?.textContent).toBe(
        "Memory: open your knowledge workspace",
      ),
    );
    validSettingsInstance.shadowRoot?.querySelector<HTMLButtonElement>(".tour-close")?.click();
  });
});
