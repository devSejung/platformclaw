import { createRouter, normalizeRoutePath } from "@openclaw/uirouter";
import type { PageDefinition, RouteLocation, Router, RouterHistory } from "@openclaw/uirouter";
import {
  APP_ROUTE_IDS,
  agentRouteFromPath,
  INTERNAL_AGENT_PATH_PARAM,
  INTERNAL_MEMORY_PATH_PARAM,
  INTERNAL_PLUGINS_PATH_PARAM,
  INTERNAL_SESSION_PATH_PARAM,
  INTERNAL_WORKBOARD_PATH_PARAM,
  memoryTabFromPath,
  locationForRoute,
  pathForAgentPanel,
  pathForRoute,
  pluginsHubTabFromPath,
  routePageSpec,
  routeIdFromPath,
  sessionRouteNamespaceFromPath,
  workboardBoardIdFromPath,
  type RouteId,
} from "./app-route-paths.ts";
import type { ApplicationContext } from "./app/context.ts";
import { page as aboutPage } from "./pages/about/route.ts";
import { page as activityPage } from "./pages/activity/route.ts";
import { page as agentsPage } from "./pages/agents/route.ts";
import { page as approvalsPage } from "./pages/approvals/route.ts";
import { page as appsPage } from "./pages/apps/route.ts";
import { page as channelsPage } from "./pages/channels/route.ts";
import { pages as chatPages } from "./pages/chat/route.ts";
import { pages as configPages } from "./pages/config/route.ts";
import { page as connectionPage } from "./pages/connection/route.ts";
import { page as cronPage } from "./pages/cron/route.ts";
import { page as custodianPage } from "./pages/custodian/route.ts";
import { page as dashboardsPage } from "./pages/dashboards/route.ts";
import { page as debugPage } from "./pages/debug/route.ts";
import { page as labsPage } from "./pages/labs/route.ts";
import { page as lobsterdexPage } from "./pages/lobsterdex/route.ts";
import { page as logsPage } from "./pages/logs/route.ts";
import { page as memoryImportPage } from "./pages/memory-import/route.ts";
import { page as modelProvidersPage } from "./pages/model-providers/route.ts";
import { page as modelSetupPage } from "./pages/model-setup/route.ts";
import { page as newSessionPage } from "./pages/new-session/route.ts";
import { page as nodesPage } from "./pages/nodes/route.ts";
import { page as pluginPage } from "./pages/plugin/route.ts";
import { page as pluginsPage } from "./pages/plugins/route.ts";
import { page as profilePage } from "./pages/profile/route.ts";
import { page as sessionsPage } from "./pages/sessions/route.ts";
import { page as skillHubPage } from "./pages/skill-hub/route.ts";
import { page as skillWorkshopPage } from "./pages/skill-workshop/route.ts";
import { page as skillsPage } from "./pages/skills/route.ts";
import { page as tasksPage } from "./pages/tasks/route.ts";
import { page as usagePage } from "./pages/usage/route.ts";
import { page as workboardPage } from "./pages/workboard/route.ts";
import { page as worktreesPage } from "./pages/worktrees/route.ts";

type AppRouteModule = {
  render: (data: unknown) => unknown;
};

export type ApplicationRouter = Router<
  RouteId,
  ApplicationContext<RouteId>,
  AppRouteModule,
  unknown
>;
type AppRoute = PageDefinition<RouteId, ApplicationContext<RouteId>, AppRouteModule>;

export type ApplicationRouteOverride = Partial<
  Pick<AppRoute, "component" | "loader" | "loaderDeps">
>;

const APP_ROUTE_TREE = [
  ...chatPages,
  custodianPage,
  newSessionPage,
  activityPage,
  dashboardsPage,
  appsPage,
  agentsPage,
  approvalsPage,
  channelsPage,
  connectionPage,
  labsPage,
  aboutPage,
  lobsterdexPage,
  ...configPages,
  modelSetupPage,
  modelProvidersPage,
  memoryImportPage,
  profilePage,
  workboardPage,
  worktreesPage,
  sessionsPage,
  usagePage,
  debugPage,
  logsPage,
  skillHubPage,
  skillWorkshopPage,
  skillsPage,
  pluginsPage,
  cronPage,
  tasksPage,
  nodesPage,
  pluginPage,
] as const;

const appRoutes = APP_ROUTE_TREE as readonly AppRoute[];

export function normalizeEnabledRouteIds(enabledRouteIds: readonly RouteId[]): readonly RouteId[] {
  return enabledRouteIds.includes("chat") ? enabledRouteIds : ["chat", ...enabledRouteIds];
}

function returningToActiveMatch(
  router: ApplicationRouter,
  routeId: RouteId,
  context: ApplicationContext<RouteId>,
  location: RouteLocation,
): boolean {
  const { matches, pendingMatches } = router.getState();
  const active = matches[0];
  const pending = pendingMatches[0];
  return (
    active?.routeId === routeId &&
    active.status === "success" &&
    !active.invalid &&
    pending?.status === "pending" &&
    pending.module === undefined &&
    pending.id !== active.id &&
    active.deps === (router.getRoute(routeId)?.loaderDeps?.(context, location) ?? "")
  );
}

export function createApplicationRouter(
  enabledRouteIds: readonly RouteId[] = APP_ROUTE_IDS,
  routeOverrides: Readonly<Partial<Record<RouteId, ApplicationRouteOverride>>> = {},
): ApplicationRouter {
  const enabled = new Set(normalizeEnabledRouteIds(enabledRouteIds));
  const builtInRouteIds = new Set<RouteId>(appRoutes.map((route) => route.id));
  const embeddedRoutes = [...enabled].flatMap((routeId) => {
    if (builtInRouteIds.has(routeId)) {
      return [];
    }
    const override = routeOverrides[routeId];
    if (!override?.component) {
      return [];
    }
    return [{ ...routePageSpec(routeId), ...override, component: override.component } as AppRoute];
  });
  const router = createRouter<RouteId, ApplicationContext<RouteId>, AppRouteModule>({
    routes: [
      ...appRoutes
        .filter((route) => enabled.has(route.id))
        .map((route) => Object.assign({}, route, routeOverrides[route.id])),
      ...embeddedRoutes,
    ] as readonly AppRoute[],
  });
  // The shared router intentionally matches exact paths only. Workboard ids,
  // hub tabs, and session refs are runtime data, so the app owns those paths.
  return {
    ...router,
    navigate: (
      routeId,
      context,
      options = {},
      location = locationForRoute(routeId, context.basePath),
    ) => {
      // uirouter reuses a successful active match before cancelling a cold
      // sibling. Revalidation retains its module while retiring the old load.
      const normalizedLocation = { ...location, pathname: normalizeRoutePath(location.pathname) };
      const next = returningToActiveMatch(router, routeId, context, normalizedLocation)
        ? { ...options, revalidate: true }
        : options;
      return router.navigate(routeId, context, next, normalizedLocation);
    },
    routeIdFromPath: (pathname, basePath = "") => {
      const routeId = routeIdFromPath(pathname, basePath);
      return routeId !== null && enabled.has(routeId) ? routeId : null;
    },
  };
}

type DynamicRoute = readonly [routeId: RouteId, searchKey: string, searchValue: string];

function dynamicRouteFromPath(pathname: string, basePath: string): DynamicRoute | null {
  const agentRoute = agentRouteFromPath(pathname, basePath);
  if (agentRoute) {
    return ["agents", INTERNAL_AGENT_PATH_PARAM, pathname];
  }
  const boardId = workboardBoardIdFromPath(pathname, basePath);
  if (boardId) {
    return ["workboard", INTERNAL_WORKBOARD_PATH_PARAM, pathname];
  }
  const memoryTab = memoryTabFromPath(pathname, basePath);
  if (memoryTab && memoryTab !== "overview") {
    return ["memory", INTERNAL_MEMORY_PATH_PARAM, pathname];
  }
  const pluginsTab = pluginsHubTabFromPath(pathname, basePath);
  if (pluginsTab === "discover") {
    return ["plugins", INTERNAL_PLUGINS_PATH_PARAM, pathname];
  }
  const sessionNamespace = sessionRouteNamespaceFromPath(pathname, basePath);
  return sessionNamespace ? [sessionNamespace, INTERNAL_SESSION_PATH_PARAM, pathname] : null;
}

function routerHistoryLocation(location: ReturnType<RouterHistory["location"]>, basePath: string) {
  const dynamicRoute = dynamicRouteFromPath(location.pathname, basePath);
  if (!dynamicRoute) {
    return location;
  }
  const [routeId, searchKey, searchValue] = dynamicRoute;
  const search = new URLSearchParams(location.search);
  search.set(searchKey, searchValue);
  return {
    ...location,
    pathname: pathForRoute(routeId, basePath),
    search: `?${search.toString()}`,
  };
}

function sameRouteLocation(left: RouteLocation, right: RouteLocation): boolean {
  return (
    left.pathname === right.pathname && left.search === right.search && left.hash === right.hash
  );
}

export async function startApplicationRouter(
  router: ApplicationRouter,
  history: RouterHistory,
  basePath: string,
  context: ApplicationContext<RouteId>,
): Promise<void> {
  let location = history.location();
  const initialAgentRoute = agentRouteFromPath(location.pathname, basePath);
  if (initialAgentRoute?.invalidPanel) {
    history.replace({
      ...location,
      pathname: pathForAgentPanel(initialAgentRoute.agentId, null, basePath),
    });
    location = history.location();
  }
  const routeId = router.routeIdFromPath(location.pathname, basePath);
  // Unknown paths (including retired routes like /overview) land on chat, so
  // removed pages need no legacy aliases for stale bookmarks or history.
  if (routeId === null) {
    history.replace({
      ...location,
      pathname: router.pathForRoute("chat", basePath),
    });
    location = history.location();
  }
  const initialDynamicRoute = dynamicRouteFromPath(location.pathname, basePath);
  const applicationHistory: RouterHistory = {
    location: () => routerHistoryLocation(history.location(), basePath),
    push: (next) => history.push(next),
    replace: (next) => history.replace(next),
    listen: () =>
      history.listen((next) => {
        const nextRouteId = router.routeIdFromPath(next.pathname, basePath);
        const nextLocation =
          nextRouteId === null
            ? { ...next, pathname: router.pathForRoute("chat", basePath) }
            : next;
        if (nextRouteId === null) {
          history.replace(nextLocation);
        }
        // Static and dynamic history entries share the app's cancellation policy.
        void router
          .navigate(nextRouteId ?? "chat", context, { history: "none" }, nextLocation)
          .catch((error: unknown) => {
            console.error("[openclaw] History route navigation failed", error);
          });
      }),
  };
  await router.start(applicationHistory, basePath, context);
  if (initialDynamicRoute && sameRouteLocation(history.location(), location)) {
    // Replace the synthetic exact-match location with the real browser path
    // before the shell renders. A loader-visible redirect wins if it already
    // moved history while startup was still resolving.
    await router.navigate(initialDynamicRoute[0], context, { history: "none" }, location);
  }
}

export {
  APP_ROUTE_IDS,
  isRouteId,
  locationForRoute,
  routeIdFromPath,
  type RouteId,
} from "./app-route-paths.ts";
