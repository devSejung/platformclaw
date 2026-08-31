import { platformClawGuideT as guideT } from "./i18n.ts";

export type TourStep = {
  id: string;
  title: string;
  body: string;
  details?: string[];
  element?: () => Element | null;
  activate?: () => boolean | void | Promise<boolean | void>;
};

type TourActions = {
  tourElement: (selector: string, shadowSelector?: string) => Element;
  findSettingsRoute: (route: string) => Element | null;
  openHomeToTerminal: () => Promise<boolean>;
  openPluginsHub: () => Promise<boolean>;
  activatePluginHubTab: (tab: string) => Promise<boolean>;
  openSettings: () => Promise<boolean>;
  openMemory: () => Promise<boolean>;
  activateMemoryTab: (tab: string) => Promise<boolean>;
  openHome: () => Promise<boolean>;
};

export function findSidebarRoute(...routes: string[]): Element | null {
  const sidebar = document.querySelector("openclaw-app-sidebar");
  const roots = [sidebar, sidebar?.shadowRoot].filter(Boolean) as ParentNode[];
  for (const root of roots) {
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a.nav-item[href]")) {
      try {
        const pathname = new URL(anchor.href, globalThis.location.href).pathname;
        if (routes.some((route) => pathname.endsWith(`/${route}`))) {
          return anchor;
        }
      } catch {
        // Ignore malformed non-navigation links from optional product content.
      }
    }
  }
  return null;
}

export function findSidebarHome(): Element | null {
  const sidebar = document.querySelector("openclaw-app-sidebar");
  return (sidebar?.shadowRoot?.querySelector(".nav-item--home") ??
    sidebar?.querySelector(".nav-item--home")) as Element | null;
}

export function findSidebarSettings(): Element | null {
  const sidebar = document.querySelector("openclaw-app-sidebar");
  return (sidebar?.shadowRoot?.querySelector('[data-tour="settings"]') ??
    sidebar?.querySelector('[data-tour="settings"]')) as Element | null;
}

export function findPluginHubElement(selector: string): Element | null {
  return document.querySelector(selector);
}

export function findSettingsElement(selector: string): Element | null {
  return document.querySelector(selector);
}

export function findSettingsRoute(route: string): Element | null {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
    ".settings-sidebar__item[href]",
  )) {
    if (new URL(anchor.href, globalThis.location.href).pathname.endsWith(`/${route}`)) {
      return anchor;
    }
  }
  return null;
}

export function findChatTerminal(): Element | null {
  return document.querySelector('[data-tour="terminal"]');
}

export async function waitForElement(find: () => Element | null): Promise<Element | null> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const element = find();
    if (element) {
      return element;
    }
    await new Promise<void>((resolve) => {
      globalThis.requestAnimationFrame(() => resolve());
    });
  }
  return null;
}

export async function waitForTourTarget(
  find: () => Element | null,
  expectedStepId: string,
  isCurrent: (stepId: string) => boolean,
  layoutAttempts = 90,
): Promise<Element | null> {
  for (let attempt = 0; attempt < layoutAttempts; attempt += 1) {
    if (!isCurrent(expectedStepId)) {
      return null;
    }
    const candidate = find();
    const candidateRect = candidate?.getBoundingClientRect();
    if (
      candidate?.isConnected &&
      candidateRect &&
      candidateRect.width > 0 &&
      candidateRect.height > 0
    ) {
      candidate.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    await new Promise<void>((resolve) => {
      globalThis.requestAnimationFrame(() => resolve());
    });
    if (!isCurrent(expectedStepId)) {
      return null;
    }
    // Route-owned tab strips replace their nodes. Requery after scrolling so a stale node
    // cannot resurrect a highlight or global listeners after its owner disconnects.
    const element = find();
    const rect = element?.getBoundingClientRect();
    if (
      element?.isConnected &&
      rect &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < globalThis.innerHeight &&
      rect.left < globalThis.innerWidth
    ) {
      return element;
    }
  }
  return null;
}

function isTerminalTourAvailable(): boolean {
  const sidebar = document.querySelector("openclaw-app-sidebar") as
    | (Element & { terminalAvailable?: boolean })
    | null;
  return findChatTerminal() !== null || sidebar?.terminalAvailable === true;
}

export function buildPlatformClawTourSteps(actions: TourActions): TourStep[] {
  const catalogTabsAvailable = Boolean(findSidebarRoute("settings/plugins"));
  const terminalSteps: TourStep[] = isTerminalTourAvailable()
    ? [
        {
          id: "terminal",
          title: guideT("platformClaw.guide.terminalTitle"),
          body: guideT("platformClaw.guide.terminalBody"),
          details: guideT("platformClaw.guide.terminalDetails").split("|"),
          element: findChatTerminal,
          activate: actions.openHomeToTerminal,
        },
      ]
    : [];
  const pluginCatalogSteps: TourStep[] = catalogTabsAvailable
    ? [
        {
          id: "installed-plugins",
          title: guideT("platformClaw.guide.installedPluginsTitle"),
          body: guideT("platformClaw.guide.installedPluginsBody"),
          details: guideT("platformClaw.guide.installedPluginsDetails").split("|"),
          element: () => findPluginHubElement("#plugins-tab-installed"),
          activate: () => actions.activatePluginHubTab("installed"),
        },
        {
          id: "discover-plugins",
          title: guideT("platformClaw.guide.discoverPluginsTitle"),
          body: guideT("platformClaw.guide.discoverPluginsBody"),
          details: guideT("platformClaw.guide.discoverPluginsDetails").split("|"),
          element: () => findPluginHubElement("#plugins-tab-discover"),
          activate: () => actions.activatePluginHubTab("discover"),
        },
      ]
    : [];
  return [
    {
      id: "welcome",
      title: guideT("platformClaw.guide.welcomeTitle"),
      body: guideT("platformClaw.guide.welcomeBody"),
    },
    {
      id: "chat",
      title: guideT("platformClaw.guide.chatTitle"),
      body: guideT("platformClaw.guide.chatBody"),
      details: guideT("platformClaw.guide.chatDetails").split("|"),
      element: findSidebarHome,
    },
    ...terminalSteps,
    {
      id: "usage",
      title: guideT("platformClaw.guide.usageTitle"),
      body: guideT("platformClaw.guide.usageBody"),
      details: guideT("platformClaw.guide.usageDetails").split("|"),
      element: () => findSidebarRoute("usage"),
    },
    {
      id: "tasks",
      title: guideT("platformClaw.guide.tasksTitle"),
      body: guideT("platformClaw.guide.tasksBody"),
      details: guideT("platformClaw.guide.tasksDetails").split("|"),
      element: () => findSidebarRoute("tasks"),
    },
    {
      id: "sessions",
      title: guideT("platformClaw.guide.sessionsTitle"),
      body: guideT("platformClaw.guide.sessionsBody"),
      details: guideT("platformClaw.guide.sessionsDetails").split("|"),
      element: () => findSidebarRoute("sessions"),
    },
    {
      id: "activity",
      title: guideT("platformClaw.guide.activityTitle"),
      body: guideT("platformClaw.guide.activityBody"),
      details: guideT("platformClaw.guide.activityDetails").split("|"),
      element: () => findSidebarRoute("activity"),
    },
    {
      id: "automations",
      title: guideT("platformClaw.guide.automationsTitle"),
      body: guideT("platformClaw.guide.automationsBody"),
      details: guideT("platformClaw.guide.automationsDetails").split("|"),
      element: () => findSidebarRoute("automations", "cron"),
    },
    {
      id: "skills",
      title: guideT("platformClaw.guide.skillsTitle"),
      body: guideT("platformClaw.guide.skillsBody"),
      details: guideT("platformClaw.guide.skillsDetails").split("|"),
      element: () => findPluginHubElement(".plugins-content-header"),
      activate: () => actions.activatePluginHubTab("skills"),
    },
    {
      id: "workshop",
      title: guideT("platformClaw.guide.workshopTitle"),
      body: guideT("platformClaw.guide.workshopBody"),
      details: guideT("platformClaw.guide.workshopDetails").split("|"),
      element: () => findPluginHubElement(".plugins-content-header"),
      activate: () => actions.activatePluginHubTab("workshop"),
    },
    {
      id: "skill-hub",
      title: guideT("platformClaw.guide.skillHubTitle"),
      body: guideT("platformClaw.guide.skillHubBody"),
      details: guideT("platformClaw.guide.skillHubDetails").split("|"),
      element: () => findPluginHubElement(".plugins-content-header"),
      activate: () => actions.activatePluginHubTab("skill-hub"),
    },
    {
      id: "work-location",
      title: guideT("platformClaw.guide.workLocationTitle"),
      body: guideT("platformClaw.guide.workLocationBody"),
      element: () => actions.tourElement("platformclaw-execution-settings", '[data-action="open"]'),
    },
    ...pluginCatalogSteps,
    {
      id: "settings-nav",
      title: guideT("platformClaw.guide.settingsNavTitle"),
      body: guideT("platformClaw.guide.settingsNavBody"),
      details: guideT("platformClaw.guide.settingsNavDetails").split("|"),
      element: findSidebarSettings,
    },
    {
      id: "settings-overview",
      title: guideT("platformClaw.guide.settingsTitle"),
      body: guideT("platformClaw.guide.settingsBody"),
      details: guideT("platformClaw.guide.settingsDetails").split("|"),
      element: () => findSettingsElement(".settings-sidebar"),
      activate: actions.openSettings,
    },
    {
      id: "organization-nav",
      title: guideT("platformClaw.guide.organizationNavTitle"),
      body: guideT("platformClaw.guide.organizationNavBody"),
      details: guideT("platformClaw.guide.organizationNavDetails").split("|"),
      element: () => actions.findSettingsRoute("settings/organization"),
    },
    {
      id: "memory-nav",
      title: guideT("platformClaw.guide.memoryNavTitle"),
      body: guideT("platformClaw.guide.memoryNavBody"),
      details: guideT("platformClaw.guide.memoryNavDetails").split("|"),
      element: () => actions.findSettingsRoute("settings/memory"),
    },
    {
      id: "memory-overview",
      title: guideT("platformClaw.guide.memoryOverviewTitle"),
      body: guideT("platformClaw.guide.memoryOverviewBody"),
      details: guideT("platformClaw.guide.memoryOverviewDetails").split("|"),
      element: () => findSettingsElement(".platformclaw-memory-page__tabs"),
      activate: actions.openMemory,
    },
    {
      id: "personal-memory",
      title: guideT("platformClaw.guide.personalMemoryTitle"),
      body: guideT("platformClaw.guide.personalMemoryBody"),
      details: guideT("platformClaw.guide.personalMemoryDetails").split("|"),
      element: () => findSettingsElement("#platformclaw-memory-tab-memory"),
      activate: () => actions.activateMemoryTab("memory"),
    },
    {
      id: "personal-wiki",
      title: guideT("platformClaw.guide.personalWikiTitle"),
      body: guideT("platformClaw.guide.personalWikiBody"),
      details: guideT("platformClaw.guide.personalWikiDetails").split("|"),
      element: () => findSettingsElement("#platformclaw-memory-tab-wiki"),
      activate: () => actions.activateMemoryTab("wiki"),
    },
    {
      id: "organization-memory",
      title: guideT("platformClaw.guide.organizationMemoryTitle"),
      body: guideT("platformClaw.guide.organizationMemoryBody"),
      details: guideT("platformClaw.guide.organizationMemoryDetails").split("|"),
      element: () => findSettingsElement("#platformclaw-memory-tab-organization"),
      activate: () => actions.activateMemoryTab("organization"),
    },
    {
      id: "dreaming",
      title: guideT("platformClaw.guide.dreamingTitle"),
      body: guideT("platformClaw.guide.dreamingBody"),
      details: guideT("platformClaw.guide.dreamingDetails").split("|"),
      element: () => findSettingsElement("#platformclaw-memory-tab-dreaming"),
      activate: () => actions.activateMemoryTab("dreaming"),
    },
    {
      id: "reopen-guide",
      title: guideT("platformClaw.guide.reopenTitle"),
      body: guideT("platformClaw.guide.reopenBody"),
      details: guideT("platformClaw.guide.reopenDetails").split("|"),
      element: () => actions.tourElement('[data-tour="guide"]'),
      activate: actions.openHome,
    },
  ];
}
