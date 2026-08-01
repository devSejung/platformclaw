import { html, nothing } from "lit";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationBootstrapOptions, ApplicationShellSession } from "../app/bootstrap.ts";
import { normalizeGatewayTokenScope } from "../app/gateway-scope.ts";
import "./execution-settings.ts";
import "./mcp-administration.ts";
import "./mcp-settings.ts";
import {
  PLATFORMCLAW_APP_PATH,
  PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME,
  type PlatformClawWebDescriptor,
  readPlatformClawWebDescriptor,
} from "./web-contract.ts";

export type PlatformClawSessionIdentity = {
  accountId: string;
  displayName: string;
  department: string;
  globalRole: "member" | "admin";
};

type PlatformClawSessionPayload = {
  authenticated: true;
  user: PlatformClawSessionIdentity;
};

type PlatformClawSessionCheck =
  | { status: "active"; payload: PlatformClawSessionPayload }
  | { status: "inactive" }
  | { status: "unavailable" };

type PlatformClawControlUiAdapterOptions = {
  root?: ParentNode;
  location?: Pick<Location, "href" | "origin" | "protocol">;
  fetchImpl?: typeof fetch;
  navigate?: (url: string) => void;
  sessionStorage?: Pick<Storage, "removeItem"> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSessionPayload(value: unknown): PlatformClawSessionPayload | null {
  if (!isRecord(value) || value.authenticated !== true || !isRecord(value.user)) {
    return null;
  }
  const { accountId, displayName, department, globalRole } = value.user;
  if (
    typeof accountId !== "string" ||
    !accountId.trim() ||
    typeof displayName !== "string" ||
    !displayName.trim() ||
    typeof department !== "string" ||
    (globalRole !== "member" && globalRole !== "admin")
  ) {
    return null;
  }
  return {
    authenticated: true,
    user: {
      accountId: accountId.trim(),
      displayName: displayName.trim(),
      department: department.trim(),
      globalRole,
    },
  };
}

function websocketUrl(location: Pick<Location, "origin" | "protocol">, path: string): string {
  const url = new URL(path, location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function browserSessionStorage(): Pick<Storage, "removeItem"> | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export class PlatformClawControlUiAdapter {
  private sessionCheck: Promise<PlatformClawSessionCheck> | null = null;

  constructor(
    readonly descriptor: PlatformClawWebDescriptor,
    private readonly location: Pick<Location, "href" | "origin" | "protocol">,
    private readonly fetchImpl: typeof fetch,
    private readonly navigate: (url: string) => void,
    private readonly sessionStorage: Pick<Storage, "removeItem"> | null,
  ) {}

  async loadSession(refresh = false): Promise<PlatformClawSessionIdentity | null> {
    if (refresh) {
      this.sessionCheck = null;
    }
    const result = await this.checkSession();
    if (result.status === "inactive") {
      this.clearBrowserSessionState();
      this.redirectToLogin(true);
      return null;
    }
    if (result.status === "unavailable") {
      throw new Error("PlatformClaw session service is unavailable");
    }
    return result.payload.user;
  }

  applicationOptions(
    identity: PlatformClawSessionIdentity,
    onLogout: () => Promise<void>,
  ): ApplicationBootstrapOptions {
    if (identity.globalRole === "admin") {
      void import("./vm-administration.ts").catch(() => {
        // A stale deployment chunk must not break the upstream Control UI session.
      });
    }
    const onUnauthenticated = () => {
      this.clearBrowserSessionState();
      this.redirectToLogin(true);
    };
    const shellSession: ApplicationShellSession = {
      primaryLabel: identity.displayName,
      secondaryLabel: identity.department || identity.accountId,
      renderFooterAccessory: () => html`
        <style>
          .platformclaw-mcp-navigation {
            box-sizing: border-box;
            display: flex;
            min-height: 34px;
            align-items: center;
            border-radius: var(--radius-md);
            padding: 7px 9px;
            color: var(--text);
            text-decoration: none;
          }
          .platformclaw-mcp-navigation:hover,
          .platformclaw-mcp-navigation:focus-visible {
            background: var(--bg-hover);
            outline: none;
          }
        </style>
        <platformclaw-execution-settings
          .fetchImpl=${this.fetchImpl}
          .onUnauthenticated=${onUnauthenticated}
        ></platformclaw-execution-settings>
        <a
          class="platformclaw-mcp-navigation"
          href="${PLATFORMCLAW_APP_PATH}/settings/mcp"
          title="MCP settings"
          >MCP</a
        >
        ${identity.globalRole === "admin"
          ? html`<platformclaw-vm-administration
              .fetchImpl=${this.fetchImpl}
              .onUnauthenticated=${onUnauthenticated}
            ></platformclaw-vm-administration>`
          : nothing}
      `,
      onLogout,
    };
    const enabledRouteIds = this.descriptor.enabledRoutes.filter(
      (routeId) => routeId !== "plugins" || identity.globalRole === "admin",
    ) as readonly RouteId[];
    const sidebarEntries = [
      "route:usage",
      "route:tasks",
      "route:sessions",
      "route:activity",
      "route:cron",
      "route:plugins",
    ];
    return {
      accessMode: "personal-agent",
      enabledRouteIds,
      routeOverrides: {
        mcp: {
          loaderDeps: () => "platformclaw-mcp",
          loader: async () => undefined,
          component: async () => ({
            header: true,
            render: () => html`
              <style>
                .platformclaw-mcp-page {
                  width: min(920px, 100%);
                  margin: 0 auto;
                  padding: 0 20px 48px;
                }
              </style>
              <section class="content-header">
                <div><div class="page-title">MCP</div></div>
              </section>
              <main class="platformclaw-mcp-page">
                ${identity.globalRole === "admin"
                  ? html`<platformclaw-mcp-administration
                      .fetchImpl=${this.fetchImpl}
                      .onUnauthenticated=${onUnauthenticated}
                    ></platformclaw-mcp-administration>`
                  : nothing}
                <platformclaw-mcp-settings
                  .fetchImpl=${this.fetchImpl}
                  .onUnauthenticated=${onUnauthenticated}
                ></platformclaw-mcp-settings>
              </main>
            `,
          }),
        },
      },
      gateway: {
        url: websocketUrl(this.location, this.descriptor.gatewayPath),
        browserDeviceAuth: false,
        onClose: (info) => {
          if (info.code === 1008) {
            void this.verifySessionAfterPolicyClose();
          }
        },
      },
      navigation: {
        sidebarEntries,
        sidebarRouteTargets: identity.globalRole === "admin" ? undefined : { plugins: "skills" },
      },
      shellSession,
    };
  }

  async logout(stopApplication: () => void): Promise<void> {
    try {
      await this.fetchImpl(this.descriptor.logoutPath, {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      // Local teardown and navigation must not depend on the logout response.
    } finally {
      stopApplication();
      this.clearBrowserSessionState();
      this.redirectToLogin(false);
    }
  }

  private async verifySessionAfterPolicyClose(): Promise<void> {
    this.sessionCheck = null;
    const result = await this.checkSession();
    if (result.status === "inactive") {
      this.clearBrowserSessionState();
      this.redirectToLogin(true);
    }
  }

  private checkSession(): Promise<PlatformClawSessionCheck> {
    const check = (this.sessionCheck ??= this.fetchImpl(this.descriptor.sessionPath, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(async (response): Promise<PlatformClawSessionCheck> => {
        if (!response.ok) {
          return { status: "unavailable" };
        }
        const value = (await response.json()) as unknown;
        const payload = parseSessionPayload(value);
        if (payload) {
          return { status: "active", payload };
        }
        return isRecord(value) && value.authenticated === false
          ? { status: "inactive" }
          : { status: "unavailable" };
      })
      .catch((): PlatformClawSessionCheck => ({ status: "unavailable" })));
    return check;
  }

  private redirectToLogin(includeReturnTo: boolean): void {
    const login = new URL(this.descriptor.loginPath, this.location.origin);
    if (includeReturnTo) {
      const current = new URL(this.location.href);
      if (
        current.origin === this.location.origin &&
        (current.pathname === PLATFORMCLAW_APP_PATH ||
          current.pathname.startsWith(`${PLATFORMCLAW_APP_PATH}/`))
      ) {
        login.searchParams.set("returnTo", `${current.pathname}${current.search}${current.hash}`);
      }
    }
    this.navigate(`${login.pathname}${login.search}`);
  }

  private clearBrowserSessionState(): void {
    if (!this.sessionStorage) {
      return;
    }
    const gatewayUrl = websocketUrl(this.location, this.descriptor.gatewayPath);
    const encodedGateway = encodeURIComponent(gatewayUrl);
    const keys = [
      `openclaw.control.chatComposer.v2:${encodedGateway}`,
      `openclaw.control.chatComposer.v1:${encodedGateway.slice(0, 240)}`,
      `openclaw.control.token.v1:${normalizeGatewayTokenScope(gatewayUrl)}`,
    ];
    try {
      for (const key of keys) {
        this.sessionStorage.removeItem(key);
      }
    } catch {
      // Browser storage cleanup is best-effort; server revocation remains authoritative.
    }
  }
}

export function createPlatformClawControlUiAdapter(
  options: PlatformClawControlUiAdapterOptions = {},
): PlatformClawControlUiAdapter | null {
  const root = options.root ?? document;
  const descriptorMeta = root.querySelector(
    `meta[name="${PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME}"]`,
  );
  if (!descriptorMeta) {
    return null;
  }
  const location = options.location ?? window.location;
  return new PlatformClawControlUiAdapter(
    readPlatformClawWebDescriptor(root),
    location,
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    options.navigate ?? ((url) => window.location.replace(url)),
    options.sessionStorage === undefined ? browserSessionStorage() : options.sessionStorage,
  );
}
