import { html, type TemplateResult } from "lit";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/plugins.css";
import {
  PLUGINS_HUB_PANEL_ID,
  pluginsHubTabsForContext,
  type PluginsHubTab,
} from "./plugins-hub.ts";

type PluginsHubShellProps = {
  context?: Pick<ApplicationContext<RouteId>, "accessMode" | "isRouteEnabled">;
  active: PluginsHubTab;
  header: unknown;
  content: unknown;
  className?: string;
  onSelect: (tab: PluginsHubTab) => void;
};

export function renderPluginsHubShell(props: PluginsHubShellProps): TemplateResult {
  const className = props.className ? `plugins-hub-shell ${props.className}` : "plugins-hub-shell";
  return html`<section class=${className}>
    ${props.header}
    <div class="plugins-hub-tabs-row">
      ${renderHubTabs({
        id: "plugins",
        active: props.active,
        tabs: pluginsHubTabsForContext(props.context),
        ariaLabel: t("pluginsPage.hubTablistLabel"),
        panelId: PLUGINS_HUB_PANEL_ID,
        className: "plugins-tabs",
        onSelect: props.onSelect,
      })}
    </div>
    ${props.content}
  </section>`;
}
