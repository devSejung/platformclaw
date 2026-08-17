import type { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneStore, MainSessionKeyBuilder } from "./contracts.js";

export async function resolveBrowserGatewayAccess(params: {
  token: string;
  touch: boolean;
  authService: BrowserAuthService;
  store: ControlPlaneStore;
  buildAgentMainSessionKey: MainSessionKeyBuilder;
  fail: (code: "unauthenticated" | "agent-unavailable", message: string) => never;
}) {
  const auth = await params.authService.authenticateToken(params.token, params.touch);
  if (auth.status !== "active") {
    return params.fail("unauthenticated", "active browser session required");
  }
  const binding = await params.store.getPersonalAgentBinding(auth.user.id);
  if (!binding || binding.state !== "active") {
    return params.fail("agent-unavailable", "active personal agent binding required");
  }
  return {
    user: auth.user,
    session: auth.session,
    binding,
    mainSessionKey: params.buildAgentMainSessionKey({ agentId: binding.agentId }),
  };
}
