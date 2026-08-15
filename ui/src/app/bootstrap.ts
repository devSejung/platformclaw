import type { RouteLocation } from "@openclaw/uirouter";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SidebarRouteTargets } from "../app-navigation.ts";
import { sessionRouteNamespaceFromPath } from "../app-route-paths.ts";
import {
  APP_ROUTE_IDS,
  createApplicationRouter,
  locationForRoute,
  normalizeEnabledRouteIds,
  routeIdFromPath,
  startApplicationRouter,
  type ApplicationRouteOverride,
  type ApplicationRouter,
  type RouteId,
} from "../app-routes.ts";
import { setSessionPathBuilder } from "../app-session-path-builder.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createChannelCapability } from "../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../lib/config/index.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { createWorkboardCapability } from "../lib/workboard/capability.ts";
import { loadChatObserverDisplayPreference } from "../pages/chat/chat-observer-display.ts";
import { sendSessionObserverVisibility } from "../pages/chat/chat-observer.ts";
import {
  isDefaultChatLanding,
  startModelSetupFirstRunRedirectAfterLocation,
} from "../pages/model-setup/first-run.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import { resolveApprovalDocumentMode, type ApprovalDocumentMode } from "./approval-deep-link.ts";
import { createBrowserHistory, resolveControlUiBasePath } from "./browser.ts";
import { createApplicationConfigCapability } from "./config.ts";
import type {
  ApplicationAccessMode,
  ApplicationNavigationOptions,
  ApplicationContext,
  ApplicationNavigationPreferences,
  ApplicationNavigationPreferencesSnapshot,
  ApplicationTheme,
  ApplicationThemeServerSelection,
} from "./context.ts";
import { syncCustomThemeStyleTag } from "./custom-theme.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { createInitialUserMessageHandoff } from "./initial-user-message-handoff.ts";
import { createNativeChatDrafts } from "./native-bridge.ts";
import { startNativeLinkRouting } from "./native-link-routing.ts";
import { createNativeNotificationsCapability } from "./native-notifications.ts";
import { createApplicationOverlays } from "./overlays.ts";
import {
  loadSettings,
  patchSettings,
  persistSessionToken,
  resolvePageGatewaySettings,
  saveSettings,
  type UiSettings,
} from "./settings.ts";
import { createSkillWorkshopRevisionHandoff } from "./skill-workshop-revision-handoff.ts";
import { createStartupLifecycle, type StartupStep } from "./startup-lifecycle.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";
import { startThemeTransition } from "./theme-transition.ts";
import { resolveTheme, type ThemeMode } from "./theme.ts";
import { createWebPushCapability } from "./web-push.ts";

function applyThemePresentation(settings: ReturnType<typeof loadSettings>): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const resolvedTheme = resolveTheme(settings.theme, settings.themeMode);
  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = resolvedTheme.endsWith("light") ? "light" : "dark";
  // Carapace CSS (openclaw/carapace) selects on [data-theme-resolved]; keep it
  // in lockstep with data-theme-mode so its stylesheets work unmodified here.
  root.dataset.themeResolved = root.dataset.themeMode;
  root.classList.toggle("wa-light", root.dataset.themeMode === "light");
  root.classList.toggle("wa-dark", root.dataset.themeMode === "dark");
  root.style.colorScheme = root.dataset.themeMode;
  root.style.setProperty("--control-ui-text-scale", `${(settings.textScale ?? 100) / 100}`);
  syncCustomThemeStyleTag(settings.customTheme);
}

function createApplicationTheme(
  initialSettings: UiSettings,
): ApplicationTheme & { dispose: () => void } {
  let settings = initialSettings;
  let serverSelection: ApplicationThemeServerSelection | null = null;
  let systemThemeCleanup: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const publish = () => {
    applyThemePresentation(settings);
    for (const listener of listeners) {
      listener();
    }
  };

  const detachSystemThemeListener = () => {
    systemThemeCleanup?.();
    systemThemeCleanup = undefined;
  };

  const syncSystemThemeListener = () => {
    detachSystemThemeListener();
    if (settings.themeMode !== "system" || typeof globalThis.matchMedia !== "function") {
      return;
    }
    const mediaQuery = globalThis.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (settings.themeMode === "system") {
        publish();
      }
    };
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onChange);
      systemThemeCleanup = () => mediaQuery.removeEventListener("change", onChange);
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(onChange);
      systemThemeCleanup = () => mediaQuery.removeListener(onChange);
    }
  };

  syncSystemThemeListener();

  return {
    get mode() {
      return settings.themeMode;
    },
    get serverSelection() {
      return serverSelection;
    },
    recordServerSelection(theme, scope) {
      serverSelection = { revision: (serverSelection?.revision ?? 0) + 1, scope, theme };
      publish();
    },
    setMode(mode: ThemeMode, element) {
      const currentSettings = loadSettings();
      const nextSettings = { ...currentSettings, themeMode: mode };
      const currentTheme = resolveTheme(currentSettings.theme, currentSettings.themeMode);
      const nextTheme = resolveTheme(nextSettings.theme, nextSettings.themeMode);
      startThemeTransition({
        nextTheme,
        currentTheme,
        context: { element },
        applyTheme: () => {
          settings = patchSettings({ themeMode: mode });
          publish();
          syncSystemThemeListener();
        },
      });
    },
    refresh() {
      settings = loadSettings();
      publish();
      syncSystemThemeListener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      detachSystemThemeListener();
      listeners.clear();
    },
  };
}

function createApplicationNavigationPreferences(
  initialSettings: UiSettings,
): ApplicationNavigationPreferences {
  let settings = initialSettings;
  let snapshot: ApplicationNavigationPreferencesSnapshot = {
    navCollapsed: settings.navCollapsed,
    navWidth: settings.navWidth,
    sidebarEntries: settings.sidebarEntries,
    pinnedAgentIds: settings.pinnedAgentIds ?? [],
  };
  const listeners = new Set<(next: ApplicationNavigationPreferencesSnapshot) => void>();

  return {
    get snapshot() {
      return snapshot;
    },
    update(patch) {
      const nextSnapshot = { ...snapshot, ...patch };
      if (
        nextSnapshot.navCollapsed === snapshot.navCollapsed &&
        nextSnapshot.navWidth === snapshot.navWidth &&
        nextSnapshot.sidebarEntries === snapshot.sidebarEntries &&
        nextSnapshot.pinnedAgentIds === snapshot.pinnedAgentIds
      ) {
        return;
      }
      settings = patchSettings({
        navCollapsed: nextSnapshot.navCollapsed,
        navWidth: nextSnapshot.navWidth,
        sidebarEntries: [...nextSnapshot.sidebarEntries],
        pinnedAgentIds: [...nextSnapshot.pinnedAgentIds],
      });
      snapshot = nextSnapshot;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ApplicationRuntime = {
  readonly context: ApplicationContext<RouteId>;
  readonly router: ApplicationRouter;
  readonly documentMode: ApprovalDocumentMode | null;
  readonly pendingGatewayConnection: {
    readonly gatewayUrl: string;
    readonly token: string;
  } | null;
  readonly enabledRouteIds: readonly RouteId[];
  readonly sidebarRouteTargets: SidebarRouteTargets;
  readonly settingsNavigationMode: ApplicationSettingsNavigationMode;
  readonly shellSession: ApplicationShellSession | null;
  readonly confirmPendingGatewayConnection: () => void;
  readonly cancelPendingGatewayConnection: () => void;
  start: () => Promise<void>;
  stop: () => void;
};

type ApplicationSettingsNavigationMode = "inline" | "takeover";

export type ApplicationShellSession = {
  readonly primaryLabel: string;
  readonly secondaryLabel?: string;
  /** Product-specific controls rendered inside the stable account footer. */
  readonly renderFooterAccessory?: () => unknown;
  readonly onLogout: () => Promise<void>;
};

export type ApplicationBootstrapOptions = {
  readonly accessMode?: ApplicationAccessMode;
  readonly enabledRouteIds?: readonly RouteId[];
  /** Product embedders may replace an enabled route without exposing unrelated routes. */
  readonly routeOverrides?: Readonly<Partial<Record<RouteId, ApplicationRouteOverride>>>;
  readonly sessionPathBuilderReady?: Promise<void>;
  readonly gateway?: {
    readonly url: string;
    readonly browserDeviceAuth?: boolean;
    readonly onClose?: (info: { code: number; reason: string; willRetry: boolean }) => void;
  };
  readonly shellSession?: ApplicationShellSession;
  readonly navigation?: {
    readonly sidebarEntries?: readonly string[];
    readonly sidebarRouteTargets?: SidebarRouteTargets;
    /** Embedded products may opt into the full Settings navigation shell. */
    readonly settingsNavigationMode?: ApplicationSettingsNavigationMode;
  };
};

type PendingRouterStartNavigation = {
  routeId: RouteId;
  location: RouteLocation;
  mode: "push" | "replace";
};

export function bootstrapApplication(
  options: ApplicationBootstrapOptions = {},
): ApplicationRuntime {
  const history = createBrowserHistory();
  const startupLocation = history.location();
  const initialBasePath = resolveControlUiBasePath(
    startupLocation.pathname || globalThis.location?.pathname || "/",
  );
  const documentMode = resolveApprovalDocumentMode(startupLocation.pathname, initialBasePath);
  const persistedSettings = loadSettings();
  const initialSettings = documentMode
    ? resolvePageGatewaySettings(persistedSettings)
    : persistedSettings;
  const resolvedStartup = resolveApplicationStartupSettings(initialSettings, startupLocation);
  const startup = options.gateway
    ? {
        ...resolvedStartup,
        changed: false,
        password: "",
        pendingBootstrapToken: null,
        pendingGatewayToken: null,
        pendingGatewayUrl: null,
        settings: {
          ...resolvedStartup.settings,
          gatewayUrl: options.gateway.url,
          token: "",
          sessionKey: "main",
          lastActiveSessionKey: "main",
          sidebarEntries:
            options.navigation?.sidebarEntries !== undefined
              ? [...options.navigation.sidebarEntries]
              : resolvedStartup.settings.sidebarEntries,
        },
      }
    : resolvedStartup;
  if (
    startup.location.pathname !== startupLocation.pathname ||
    startup.location.search !== startupLocation.search ||
    startup.location.hash !== startupLocation.hash
  ) {
    // Remove URL credentials before deferred routing or Gateway authentication can expose them.
    history.replace(startup.location);
  }
  if (startup.changed) {
    if (documentMode) {
      persistSessionToken(startup.settings.gatewayUrl, startup.settings.token);
    } else {
      saveSettings(startup.settings);
    }
  }
  const basePath = resolveControlUiBasePath(
    startup.location.pathname || globalThis.location?.pathname || "/",
  );
  const enabledRouteIds = normalizeEnabledRouteIds(options.enabledRouteIds ?? APP_ROUTE_IDS);
  const firstRunDefaultLanding =
    documentMode === null && isDefaultChatLanding(startup.location, basePath, routeIdFromPath);
  const sessionPathBuilderReady =
    options.sessionPathBuilderReady ??
    (documentMode
      ? Promise.resolve()
      : import("@openclaw/session-url-contract").then((contract) => {
          setSessionPathBuilder(contract.buildControlUiSessionPath);
        }));

  const settings = startup.settings;
  const gateway = createApplicationGateway(
    settings,
    startup.password ?? "",
    startup.pendingBootstrapToken ?? "",
    undefined,
    {
      persistDefaultConnectionSettings: options.gateway ? false : documentMode === null,
      browserDeviceAuth: options.gateway?.browserDeviceAuth,
      onClose: options.gateway?.onClose,
      basePath,
      ...(startup.pendingBootstrapProfile
        ? { bootstrapProfile: startup.pendingBootstrapProfile }
        : {}),
    },
  );
  const agents = createAgentCapability(gateway);
  const startupLifecycle = createStartupLifecycle();
  const startupRouteId = routeIdFromPath(startup.location.pathname, basePath);
  const releasedSessionQuery =
    (startupRouteId === "chat" || startupRouteId === "dashboard") &&
    sessionRouteNamespaceFromPath(startup.location.pathname, basePath) === null &&
    new URLSearchParams(startup.location.search).has("session");
  const deferInitialLocationUntilGateway =
    documentMode === null &&
    !releasedSessionQuery &&
    firstRunDefaultLanding &&
    settings.sessionKey.trim() !== "" &&
    !parseAgentSessionKey(settings.sessionKey);
  const initialLocationReady = (
    documentMode
      ? Promise.resolve(startup.location)
      : Promise.all([sessionPathBuilderReady, import("./bootstrap-location.ts")]).then(
          ([, location]) =>
            location.resolveInitialApplicationLocation({
              location: startup.location,
              basePath,
              sessionKey: settings.sessionKey,
              gateway,
              agentsList: () => agents.state.agentsList,
              signal: startupLifecycle.signal,
            }),
        )
  ).catch((error: unknown) => {
    // stop() aborts an eager unscoped-session lookup even when start() returns
    // at the lazy-chunk guard, so consume that teardown-only rejection here.
    if (startupLifecycle.signal.aborted) {
      return startup.location;
    }
    throw error;
  });
  const agentIdentity = createAgentIdentityCapability(gateway);
  const agentSelection = createAgentSelectionCapability(gateway, agents);
  const channels = createChannelCapability(gateway);
  const config = createApplicationConfigCapability({
    basePath,
    auth: {
      settings: { token: settings.token },
      password: startup.password ?? "",
    },
  });
  const sessions = createSessionCapability(gateway);
  const workboard = createWorkboardCapability();
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const overlays = createApplicationOverlays(gateway, {
    drainConfigWrites: () => runtimeConfig.waitForPendingWrites(),
  });
  // App-updater interlock: writing config (or restarting the gateway) while
  // the updater runs can corrupt the install; pause config writes until the
  // update settles. Wired app-lifetime so page unmounts cannot strand it.
  const syncConfigWriteSuspension = () => {
    const update = overlays.snapshot;
    runtimeConfig.setWritesSuspended(update.updateRunning || update.updateReconciliationPending);
  };
  const stopConfigWriteSuspension = overlays.subscribe(syncConfigWriteSuspension);
  syncConfigWriteSuspension();
  const navigation = createApplicationNavigationPreferences(settings);
  const theme = createApplicationTheme(settings);
  const nativeChatDrafts = createNativeChatDrafts();
  const nativeLinkRouting = startNativeLinkRouting();
  const nativeNotifications = createNativeNotificationsCapability();
  const webPush = createWebPushCapability(gateway, {
    enabled: options.accessMode !== "personal-agent",
  });
  const skillWorkshopRevision = createSkillWorkshopRevisionHandoff();
  const initialUserMessage = createInitialUserMessageHandoff();
  applyThemePresentation(settings);
  const router = createApplicationRouter(enabledRouteIds, options.routeOverrides);
  let routerStarted = false;
  // Pre-start navigations are invisible to history; retain the latest request so
  // router.start() cannot resolve the stale browser URL over the user's route.
  let pendingRouterStartNavigation: PendingRouterStartNavigation | null = null;
  let pendingGatewayConnection =
    startup.pendingGatewayUrl !== null
      ? {
          gatewayUrl: startup.pendingGatewayUrl,
          token: startup.pendingGatewayToken ?? "",
          bootstrapToken: startup.pendingBootstrapToken ?? "",
          ...(startup.pendingBootstrapProfile
            ? { bootstrapProfile: startup.pendingBootstrapProfile }
            : {}),
        }
      : null;
  let lastPostConnectClient: GatewayBrowserClient | null = null;
  const stopPostConnect = gateway.subscribe((snapshot) => {
    if (snapshot.phase !== "connected" || !snapshot.client) {
      lastPostConnectClient = null;
      return;
    }
    if (lastPostConnectClient === snapshot.client) {
      return;
    }
    lastPostConnectClient = snapshot.client;
    void config.refresh({
      auth: {
        hello: snapshot.hello,
        settings: { token: gateway.connection.token },
        password: gateway.connection.password,
      },
    });
    void sendSessionObserverVisibility(
      snapshot.client,
      loadChatObserverDisplayPreference() !== "off",
    ).catch(() => undefined);
  });
  const routeLocation = (routeId: RouteId, navigationOptions?: ApplicationNavigationOptions) => {
    const location = locationForRoute(routeId, basePath);
    const activeMatch = router.getState().matches[0];
    const activeDynamicPath =
      activeMatch?.routeId === routeId && routeId === "workboard"
        ? activeMatch.location.pathname
        : null;
    if (
      navigationOptions?.pathname !== undefined ||
      navigationOptions?.search !== undefined ||
      navigationOptions?.hash !== undefined
    ) {
      return {
        ...location,
        pathname: navigationOptions?.pathname ?? activeDynamicPath ?? location.pathname,
        search: navigationOptions?.search ?? "",
        hash: navigationOptions?.hash ?? "",
      };
    }
    return location;
  };
  const resolveAllowedNavigation = (
    routeId: RouteId,
    navigationOptions?: ApplicationNavigationOptions,
  ) => {
    const routeAllowed = enabledRouteIds.includes(routeId);
    const allowedRouteId = routeAllowed ? routeId : "chat";
    const allowedOptions = routeAllowed
      ? navigationOptions
      : navigationOptions
        ? { search: navigationOptions.search, hash: navigationOptions.hash }
        : undefined;
    return {
      routeAllowed,
      allowedRouteId,
      location: routeLocation(allowedRouteId, allowedOptions),
    };
  };
  const confirmPendingGatewayConnection = () => {
    const pending = pendingGatewayConnection;
    if (!pending) {
      return;
    }
    pendingGatewayConnection = null;
    gateway.connect({
      gatewayUrl: pending.gatewayUrl,
      token: pending.token,
      bootstrapToken: pending.bootstrapToken,
      bootstrapProfile: pending.bootstrapProfile,
    });
  };
  const cancelPendingGatewayConnection = () => {
    pendingGatewayConnection = null;
  };
  const context: ApplicationContext<RouteId> = {
    basePath,
    accessMode: options.accessMode ?? "operator",
    isRouteEnabled: (routeId) => enabledRouteIds.includes(routeId),
    gateway,
    agents,
    agentIdentity,
    agentSelection,
    channels,
    config,
    runtimeConfig,
    sessions,
    workboard,
    overlays,
    navigation,
    theme,
    nativeChatDrafts,
    nativeNotifications,
    webPush,
    skillWorkshopRevision,
    initialUserMessage,
    navigate: (routeId, navigationOptions) => {
      const { routeAllowed, allowedRouteId, location } = resolveAllowedNavigation(
        routeId,
        navigationOptions,
      );
      if (!routerStarted) {
        // A restricted pre-start request must not overwrite the allowed location
        // that startup normalized with the resolved agent/session identity.
        if (!routeAllowed) {
          return;
        }
        pendingRouterStartNavigation = { routeId: allowedRouteId, location, mode: "push" };
      }
      void router
        .navigate(allowedRouteId, context, { history: "push" }, location)
        .catch((error: unknown) => {
          console.error("[openclaw] route navigation failed", error);
        });
    },
    replace: (routeId, navigationOptions) => {
      const { routeAllowed, allowedRouteId, location } = resolveAllowedNavigation(
        routeId,
        navigationOptions,
      );
      if (!routerStarted) {
        if (!routeAllowed) {
          return;
        }
        pendingRouterStartNavigation = { routeId: allowedRouteId, location, mode: "replace" };
      }
      void router
        .navigate(allowedRouteId, context, { history: "replace" }, location)
        .catch((error: unknown) => {
          console.error("[openclaw] route replacement failed", error);
        });
    },
    revalidate: (routeId) => router.revalidate(context, routeId),
    preload: (routeId) => router.preloadRoute(routeId, context),
  };
  return {
    context,
    router,
    documentMode,
    enabledRouteIds,
    sidebarRouteTargets: options.navigation?.sidebarRouteTargets ?? {},
    // Personal-agent embedders historically render settings inline. Keep that
    // contract unless the product explicitly owns a complete settings surface.
    settingsNavigationMode:
      options.navigation?.settingsNavigationMode ??
      ((options.accessMode ?? "operator") === "operator" ? "takeover" : "inline"),
    shellSession: options.shellSession ?? null,
    get pendingGatewayConnection() {
      return pendingGatewayConnection;
    },
    confirmPendingGatewayConnection,
    cancelPendingGatewayConnection,
    start: () => {
      const stopRouter = () => router.stop();
      if (!documentMode) {
        startupLifecycle.addDisposer(stopRouter);
      }
      const steps: StartupStep[] = [
        () => {
          gateway.start();
          return () => gateway.stop();
        },
        () => sessionPathBuilderReady,
      ];
      if (!deferInitialLocationUntilGateway) {
        steps.push(() =>
          startModelSetupFirstRunRedirectAfterLocation({
            context,
            enabled: firstRunDefaultLanding,
            history,
            initialLocationReady,
          }),
        );
      }
      steps.push(() => {
        void config.refresh({ skipWithoutAuthCandidate: true });
      });
      if (!documentMode) {
        steps.push(async () => {
          const pendingNavigation = pendingRouterStartNavigation;
          pendingRouterStartNavigation = null;
          routerStarted = true;
          if (pendingNavigation) {
            history[pendingNavigation.mode](pendingNavigation.location);
          }
          await startApplicationRouter(router, history, basePath, context);
          return stopRouter;
        });
      }
      if (deferInitialLocationUntilGateway) {
        steps.push(() => {
          // The bare /chat route remains not-found while disconnected. Its shell
          // fallback is gated on the same connected defaults, so both paths converge.
          startupLifecycle.trackDisposer(
            startModelSetupFirstRunRedirectAfterLocation({
              context,
              enabled: firstRunDefaultLanding,
              history,
              initialLocationReady,
              installLocation: async (location) => {
                const routeId = routeIdFromPath(location.pathname, basePath);
                if (routeId) {
                  await router.navigate(routeId, context, { history: "replace" }, location);
                } else {
                  history.replace(location);
                }
              },
              shouldInstallLocation: () =>
                isDefaultChatLanding(history.location(), basePath, routeIdFromPath),
            }),
            (error) => {
              console.error("[openclaw] initial session location failed", error);
            },
          );
        });
      }
      return startupLifecycle.run(steps);
    },
    stop: () => {
      startupLifecycle.stop();
      stopPostConnect();
      agents.dispose();
      channels.dispose();
      sessions.dispose();
      workboard.dispose();
      stopConfigWriteSuspension();
      runtimeConfig.dispose();
      overlays.dispose();
      theme.dispose();
      nativeChatDrafts.dispose();
      nativeLinkRouting.dispose();
      nativeNotifications?.dispose();
      webPush.dispose();
      skillWorkshopRevision.clear();
      initialUserMessage.clear();
    },
  };
}
