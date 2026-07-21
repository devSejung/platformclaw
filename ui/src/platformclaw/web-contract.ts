export const PLATFORMCLAW_LOGIN_PATH = "/platformclaw/login";
export const PLATFORMCLAW_APP_PATH = "/platformclaw/app";
export const PLATFORMCLAW_DEFAULT_APP_PATH = `${PLATFORMCLAW_APP_PATH}/chat`;
export const PLATFORMCLAW_LOGIN_API_PATH = "/platformclaw/api/auth/login";
export const PLATFORMCLAW_LOGOUT_API_PATH = "/platformclaw/api/auth/logout";
export const PLATFORMCLAW_SESSION_API_PATH = "/platformclaw/api/auth/session";
export const PLATFORMCLAW_GATEWAY_PATH = "/platformclaw/gateway";

export const PLATFORMCLAW_ENABLED_ROUTES = ["chat", "new-session", "sessions"] as const;

export type PlatformClawWebDescriptor = {
  mode: "platformclaw";
  gatewayPath: typeof PLATFORMCLAW_GATEWAY_PATH;
  loginPath: typeof PLATFORMCLAW_LOGIN_PATH;
  logoutPath: typeof PLATFORMCLAW_LOGOUT_API_PATH;
  sessionPath: typeof PLATFORMCLAW_SESSION_API_PATH;
  enabledRoutes: typeof PLATFORMCLAW_ENABLED_ROUTES;
};

export const PLATFORMCLAW_WEB_DESCRIPTOR: PlatformClawWebDescriptor = {
  mode: "platformclaw",
  gatewayPath: PLATFORMCLAW_GATEWAY_PATH,
  loginPath: PLATFORMCLAW_LOGIN_PATH,
  logoutPath: PLATFORMCLAW_LOGOUT_API_PATH,
  sessionPath: PLATFORMCLAW_SESSION_API_PATH,
  enabledRoutes: PLATFORMCLAW_ENABLED_ROUTES,
};

export function resolvePlatformClawReturnTo(location: Pick<Location, "href" | "origin">): string {
  const current = new URL(location.href);
  const value = current.searchParams.get("returnTo");
  if (!value || value.includes("\\")) {
    return PLATFORMCLAW_DEFAULT_APP_PATH;
  }
  try {
    const target = new URL(value, location.origin);
    const isAppPath =
      target.pathname === PLATFORMCLAW_APP_PATH ||
      target.pathname.startsWith(`${PLATFORMCLAW_APP_PATH}/`);
    if (target.origin !== location.origin || !isAppPath) {
      return PLATFORMCLAW_DEFAULT_APP_PATH;
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return PLATFORMCLAW_DEFAULT_APP_PATH;
  }
}
