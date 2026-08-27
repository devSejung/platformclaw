/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteId } from "../../app-route-paths.ts";
import { i18n } from "../../i18n/index.ts";
import { renderPluginsHubShell } from "./plugins-hub-shell.ts";
import type { PluginsHubTab } from "./plugins-hub.ts";

const ALL_TABS: readonly PluginsHubTab[] = [
  "installed",
  "discover",
  "skills",
  "workshop",
  "skill-hub",
];

function renderShell(active: PluginsHubTab, enabledRoutes: ReadonlySet<RouteId>, showTabs = false) {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderPluginsHubShell({
      context: {
        accessMode: "personal-agent",
        isRouteEnabled: (routeId) => enabledRoutes.has(routeId),
      },
      active,
      showTabs,
      header: "Header",
      content: "Content",
      onSelect: vi.fn(),
    }),
    container,
  );
  return container;
}

function renderedTabs(container: ParentNode): string[] {
  return [...container.querySelectorAll("wa-tab")].map((tab) => tab.id.replace("plugins-tab-", ""));
}

describe("Plugins Hub shell", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each(ALL_TABS)("keeps the complete administrator tab set on %s", (active) => {
    const container = renderShell(
      active,
      new Set<RouteId>(["plugins", "skills", "skill-workshop", "skill-hub"]),
      true,
    );

    expect(renderedTabs(container)).toEqual(ALL_TABS);
    expect(container.querySelector(".plugins-hub-shell > .plugins-hub-tabs-row")).not.toBeNull();
    expect(container.querySelector(`#plugins-tab-${active}`)?.getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("omits the hub tabs for standalone destinations", () => {
    const container = renderShell(
      "skills",
      new Set<RouteId>(["skills", "skill-workshop", "skill-hub"]),
    );

    expect(renderedTabs(container)).toEqual([]);
    expect(container.querySelector(".plugins-hub-tabs-row")).toBeNull();
    expect(container.textContent).toContain("Header");
    expect(container.textContent).toContain("Content");
  });
});
