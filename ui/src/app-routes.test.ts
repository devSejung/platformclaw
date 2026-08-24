import { describe, expect, it } from "vitest";
import { APP_ROUTE_IDS, pathForRoute, routeIdFromPath } from "./app-route-paths.ts";
import { createApplicationRouter } from "./app-routes.ts";

// Page definitions derive path/aliases from the route table via routePageSpec,
// so router matching cannot disagree with routeIdFromPath/base-path inference
// about a registered page. This guards the remaining seam: every table id must
// be registered with the router exactly once, and no page may reintroduce
// hand-written paths that shadow the table.
describe("application router registration", () => {
  const router = createApplicationRouter();

  it("registers every route id exactly once", () => {
    const routeIds = router.routes.map((route) => route.id);
    expect([...routeIds].toSorted()).toEqual([...APP_ROUTE_IDS].toSorted());
  });

  it("serves the table's canonical paths and aliases", () => {
    for (const route of router.routes) {
      expect(route.path, `path for route "${route.id}"`).toBe(pathForRoute(route.id));
      for (const alias of route.aliases ?? []) {
        expect(routeIdFromPath(alias, ""), `alias "${alias}"`).toBe(route.id);
      }
    }
  });

  it("keeps chat registered as the restricted-route fallback", () => {
    const restricted = createApplicationRouter(["new-session"]);

    expect(restricted.getRoute("chat")).toBeDefined();
    expect(restricted.getRoute("new-session")).toBeDefined();
  });

  it("lets a product embedder replace one enabled route without changing its path", async () => {
    const component = async () => ({ render: () => "embedded MCP" });
    const restricted = createApplicationRouter(["mcp"], {
      mcp: { loader: async () => undefined, loaderDeps: () => "embedded", component },
    });

    expect(restricted.getRoute("mcp")?.path).toBe(pathForRoute("mcp"));
    expect(restricted.getRoute("mcp")?.component).toBe(component);
    expect(restricted.getRoute("advanced")).toBeNull();
  });

  it("registers an opt-in embedder settings route only when its component is supplied", () => {
    expect(createApplicationRouter().getRoute("credentials")).toBeNull();
    expect(createApplicationRouter().getRoute("organization")).toBeNull();

    const component = async () => ({ render: () => "embedded credentials" });
    const embedded = createApplicationRouter(["credentials"], {
      credentials: { loader: async () => undefined, component },
    });

    expect(embedded.getRoute("credentials")?.path).toBe("/settings/credentials");
    expect(embedded.getRoute("credentials")?.component).toBe(component);

    const organization = createApplicationRouter(["organization"], {
      organization: { loader: async () => undefined, component },
    });
    expect(organization.getRoute("organization")?.path).toBe("/settings/organization");
  });
});
