import { pathForPluginsHubTab } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { routeForPluginsHubTab, type PluginsHubTab } from "../plugins/plugins-hub.ts";

export function selectPluginsHubTab(
  context: Pick<ApplicationContext, "basePath" | "navigate">,
  tab: PluginsHubTab,
) {
  const route = routeForPluginsHubTab(tab);
  if (route) {
    if (route !== "skill-workshop") {
      context.navigate(route);
    }
    return;
  }
  if (tab === "installed" || tab === "discover") {
    context.navigate("plugins", {
      pathname: pathForPluginsHubTab(tab, context.basePath),
    });
  }
}
