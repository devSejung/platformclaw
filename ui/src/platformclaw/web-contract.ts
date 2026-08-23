import type { RouteId } from "../app-route-paths.ts";

const PLATFORMCLAW_LOGIN_PATH = "/platformclaw/login";
export const PLATFORMCLAW_APP_PATH = "/platformclaw/app";
export const PLATFORMCLAW_DEFAULT_APP_PATH = `${PLATFORMCLAW_APP_PATH}/chat`;
export const PLATFORMCLAW_LOGIN_API_PATH = "/platformclaw/api/auth/login";
export const PLATFORMCLAW_ADSSO_PATH = "/employee/auth/adsso";
const PLATFORMCLAW_LOGOUT_API_PATH = "/platformclaw/api/auth/logout";
export const PLATFORMCLAW_SESSION_API_PATH = "/platformclaw/api/auth/session";
const PLATFORMCLAW_GATEWAY_PATH = "/platformclaw/gateway";
export const PLATFORMCLAW_EXECUTION_API_PATH = "/platformclaw/api/execution";
export const PLATFORMCLAW_MCP_API_PATH = "/platformclaw/api/mcp";
export const PLATFORMCLAW_MCP_ADMIN_API_PATH = "/platformclaw/api/admin/mcp";
export const PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH = "/platformclaw/api/exec-credentials";
export const PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH =
  "/platformclaw/api/admin/exec-credentials";
export const PLATFORMCLAW_VM_ADMIN_API_PATH = "/platformclaw/api/admin/vm";
export const PLATFORMCLAW_VOC_API_PATH = "/platformclaw/api/voc";
export const PLATFORMCLAW_SKILL_HUB_API_PATH = "/platformclaw/api/skill-hub";
export const PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME = "platformclaw-web-descriptor";

const PLATFORMCLAW_ENABLED_ROUTES = [
  "chat",
  "new-session",
  "activity",
  "sessions",
  "usage",
  "agents",
  "tasks",
  "cron",
  "appearance",
  "memory",
  "profile",
  "notifications",
  "about",
  "skills",
  "skill-workshop",
  "skill-hub",
  "plugins",
  "mcp",
] as const satisfies readonly RouteId[];

export type PlatformClawWebDescriptor = {
  mode: "platformclaw";
  gatewayPath: typeof PLATFORMCLAW_GATEWAY_PATH;
  loginPath: typeof PLATFORMCLAW_LOGIN_PATH;
  logoutPath: typeof PLATFORMCLAW_LOGOUT_API_PATH;
  sessionPath: typeof PLATFORMCLAW_SESSION_API_PATH;
  vocEnabled: boolean;
  enabledRoutes: typeof PLATFORMCLAW_ENABLED_ROUTES;
};

export const PLATFORMCLAW_WEB_DESCRIPTOR: PlatformClawWebDescriptor = {
  mode: "platformclaw",
  gatewayPath: PLATFORMCLAW_GATEWAY_PATH,
  loginPath: PLATFORMCLAW_LOGIN_PATH,
  logoutPath: PLATFORMCLAW_LOGOUT_API_PATH,
  sessionPath: PLATFORMCLAW_SESSION_API_PATH,
  vocEnabled: false,
  enabledRoutes: PLATFORMCLAW_ENABLED_ROUTES,
};

const PLATFORMCLAW_WEB_DESCRIPTOR_KEYS = [
  "enabledRoutes",
  "gatewayPath",
  "loginPath",
  "logoutPath",
  "mode",
  "sessionPath",
  "vocEnabled",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parsePlatformClawWebDescriptor(value: unknown): PlatformClawWebDescriptor {
  if (!isRecord(value)) {
    throw new Error("PlatformClaw Web descriptor must be an object");
  }
  const keys = Object.keys(value).toSorted((left, right) => left.localeCompare(right));
  if (
    keys.length !== PLATFORMCLAW_WEB_DESCRIPTOR_KEYS.length ||
    keys.some((key, index) => key !== PLATFORMCLAW_WEB_DESCRIPTOR_KEYS[index])
  ) {
    throw new Error("PlatformClaw Web descriptor fields are invalid");
  }
  if (
    value.mode !== PLATFORMCLAW_WEB_DESCRIPTOR.mode ||
    value.gatewayPath !== PLATFORMCLAW_WEB_DESCRIPTOR.gatewayPath ||
    value.loginPath !== PLATFORMCLAW_WEB_DESCRIPTOR.loginPath ||
    value.logoutPath !== PLATFORMCLAW_WEB_DESCRIPTOR.logoutPath ||
    value.sessionPath !== PLATFORMCLAW_WEB_DESCRIPTOR.sessionPath ||
    typeof value.vocEnabled !== "boolean" ||
    !Array.isArray(value.enabledRoutes) ||
    value.enabledRoutes.length !== PLATFORMCLAW_ENABLED_ROUTES.length ||
    value.enabledRoutes.some((route, index) => route !== PLATFORMCLAW_ENABLED_ROUTES[index])
  ) {
    throw new Error("PlatformClaw Web descriptor values are invalid");
  }
  return { ...PLATFORMCLAW_WEB_DESCRIPTOR, vocEnabled: value.vocEnabled };
}

export function readPlatformClawWebDescriptor(root: ParentNode): PlatformClawWebDescriptor {
  const content = root
    .querySelector(`meta[name="${PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME}"]`)
    ?.getAttribute("content");
  if (!content) {
    throw new Error("PlatformClaw Web descriptor is missing");
  }
  try {
    return parsePlatformClawWebDescriptor(JSON.parse(content) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("PlatformClaw Web descriptor is not valid JSON", { cause: error });
    }
    throw error;
  }
}

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
