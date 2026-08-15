import { beforeEach, describe, expect, it } from "vitest";
import type { RouteId } from "../../app-route-paths.ts";
import { i18n } from "../../i18n/index.ts";
import { pluginsHubTabsForContext } from "./plugins-hub.ts";

describe("pluginsHubTabs", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("keeps every enabled tab visible for a PlatformClaw administrator", () => {
    expect(
      pluginsHubTabsForContext({
        accessMode: "personal-agent",
        isRouteEnabled: () => true,
      }).map((tab) => tab.value),
    ).toEqual(["installed", "discover", "skills", "workshop", "skill-hub"]);
  });

  it("hides plugin administration tabs from ordinary personal agents", () => {
    const enabledRoutes = new Set<RouteId>(["skills", "skill-workshop", "skill-hub"]);
    expect(
      pluginsHubTabsForContext({
        accessMode: "personal-agent",
        isRouteEnabled: (routeId) => enabledRoutes.has(routeId),
      }).map((tab) => tab.value),
    ).toEqual(["skills", "workshop", "skill-hub"]);
  });

  it("preserves the operator fallback for embedders without route introspection", () => {
    expect(pluginsHubTabsForContext({ accessMode: "operator" }).map((tab) => tab.value)).toEqual([
      "installed",
      "discover",
      "skills",
      "workshop",
      "skill-hub",
    ]);
  });
});
