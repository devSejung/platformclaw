import type { IncomingMessage, ServerResponse } from "node:http";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiBootstrapConfig,
} from "../../../src/gateway/control-ui-contract.js";
import { readPlatformClawSessionCookie } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import { sendBrowserJson } from "./browser-http-shared.js";
import type { PlatformClawGatewayBackend } from "./gateway-runtime-client.js";
import { PLATFORMCLAW_WEB_APP_PATH, PLATFORMCLAW_WEB_TERMINAL_ENABLED } from "./web-assets.js";

const BOOTSTRAP_PATH = `${PLATFORMCLAW_WEB_APP_PATH}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`;

/** Projects Gateway-owned browser policy without exposing the operator configuration. */
async function loadBrowserBootstrapConfig(
  gateway: PlatformClawGatewayBackend,
  agentId: string,
): Promise<ControlUiBootstrapConfig> {
  const [snapshot, identityResult] = await Promise.all([
    gateway.request("config.get", {}),
    gateway.request("agent.identity.get", { agentId }),
  ]);
  const response = asRecord(snapshot);
  const config = asRecord(response?.config);
  const identity = asRecord(identityResult);
  if (
    !config ||
    response?.valid !== true ||
    identity?.agentId !== agentId ||
    typeof identity.name !== "string" ||
    typeof identity.avatar !== "string"
  ) {
    throw new Error("Gateway returned an invalid browser bootstrap snapshot");
  }
  const controlUi = asRecord(asRecord(config.gateway)?.controlUi);
  const ui = asRecord(config.ui);
  const avatarStatus = identity.avatarStatus;
  return {
    basePath: PLATFORMCLAW_WEB_APP_PATH,
    assistantAgentId: agentId,
    assistantName: identity.name,
    assistantAvatar: identity.avatar,
    assistantAvatarSource:
      typeof identity.avatarSource === "string" ? identity.avatarSource : undefined,
    assistantAvatarStatus:
      avatarStatus === "none" ||
      avatarStatus === "local" ||
      avatarStatus === "remote" ||
      avatarStatus === "data"
        ? avatarStatus
        : undefined,
    assistantAvatarReason:
      typeof identity.avatarReason === "string" ? identity.avatarReason : undefined,
    serverVersion: gateway.getHello()?.server.version,
    embedSandbox:
      controlUi?.embedSandbox === "strict"
        ? "strict"
        : controlUi?.embedSandbox === "trusted"
          ? "trusted"
          : "scripts",
    allowExternalEmbedUrls: controlUi?.allowExternalEmbedUrls === true,
    seamColor: typeof ui?.seamColor === "string" ? ui.seamColor : undefined,
    // Browser media uses the agent-bound relay; operator roots and plugin
    // grants must never become capabilities of an employee browser.
    localMediaPreviewRoots: [],
    pluginFrameGrants: [],
    terminalEnabled: PLATFORMCLAW_WEB_TERMINAL_ENABLED,
  };
}

export async function handlePlatformClawBrowserBootstrapRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: { authService: BrowserAuthService; gateway: PlatformClawGatewayBackend },
): Promise<boolean> {
  if (new URL(req.url ?? "/", "http://localhost").pathname !== BOOTSTRAP_PATH) {
    return false;
  }
  const token = readPlatformClawSessionCookie(req);
  const auth = token ? await options.authService.authenticateToken(token, false) : null;
  if (auth?.status !== "active" || auth.binding.state !== "active") {
    sendBrowserJson(res, 401, { error: "active browser session required" });
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end();
    return true;
  }
  try {
    const snapshot = await loadBrowserBootstrapConfig(options.gateway, auth.binding.agentId);
    sendBrowserJson(res, 200, req.method === "HEAD" ? undefined : snapshot);
  } catch {
    sendBrowserJson(res, 503, { error: "Control UI configuration unavailable" });
  }
  return true;
}
