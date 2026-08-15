import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { HubTabOption } from "../../components/hub-tabs.ts";
import { t } from "../../i18n/index.ts";

export type PluginsHubTab = "installed" | "discover" | "skills" | "workshop" | "skill-hub";

export const PLUGINS_HUB_PANEL_ID = "plugins-hub-panel";

export function routeForPluginsHubTab(
  tab: PluginsHubTab,
): "skills" | "skill-workshop" | "skill-hub" | null {
  if (tab === "skills" || tab === "skill-hub") {
    return tab;
  }
  return tab === "workshop" ? "skill-workshop" : null;
}

export function pluginsHubTabs(
  installedCount: number | null = null,
  allowedTabs?: readonly PluginsHubTab[],
): ReadonlyArray<HubTabOption<PluginsHubTab>> {
  const tabs: ReadonlyArray<HubTabOption<PluginsHubTab>> = [
    { value: "installed", label: t("pluginsPage.installedTab"), count: installedCount },
    { value: "discover", label: t("pluginsPage.discoverTab") },
    { value: "skills", label: t("tabs.skills") },
    { value: "workshop", label: t("pluginsPage.workshopTab") },
    { value: "skill-hub", label: t("pluginsPage.skillHubTab") },
  ];
  const allowed = allowedTabs ? new Set(allowedTabs) : null;
  return allowed ? tabs.filter((tab) => allowed.has(tab.value)) : tabs;
}

const PLUGINS_HUB_TAB_ROUTES: Readonly<Record<PluginsHubTab, RouteId>> = {
  installed: "plugins",
  discover: "plugins",
  skills: "skills",
  workshop: "skill-workshop",
  "skill-hub": "skill-hub",
};

export function pluginsHubTabsForContext(
  context?: Pick<ApplicationContext<RouteId>, "accessMode" | "isRouteEnabled">,
): ReadonlyArray<HubTabOption<PluginsHubTab>> {
  if (context?.isRouteEnabled) {
    return pluginsHubTabs().filter((tab) =>
      context.isRouteEnabled?.(PLUGINS_HUB_TAB_ROUTES[tab.value]),
    );
  }
  return pluginsHubTabs(
    null,
    context?.accessMode === "personal-agent" ? ["skills", "workshop", "skill-hub"] : undefined,
  );
}
