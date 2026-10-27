import { CONTROL_UI_SERVER_AUTHORIZED_METHODS_CAPABILITY } from "../../../src/gateway/control-ui-contract.js";
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";

export type GatewayMethodOperatorScope = "operator.read" | "operator.write" | "operator.admin";

export function isGatewayMethodAdvertised(
  host: {
    advertisedMethods?: string[] | null;
    hello?: {
      features?: { methods?: string[] } | null;
    } | null;
  },
  method: string,
): boolean | null {
  const methods = host.hello?.features?.methods ?? host.advertisedMethods;
  if (!Array.isArray(methods)) {
    return null;
  }
  return methods.includes(method);
}

export function isGatewayCapabilityAdvertised(
  host: {
    hello?: {
      features?: { capabilities?: string[] } | null;
    } | null;
  },
  capability: string,
): boolean | null {
  const capabilities = host.hello?.features?.capabilities;
  if (!Array.isArray(capabilities)) {
    return null;
  }
  return capabilities.includes(capability);
}

/**
 * Combines the active connection, advertised method catalog, and operator
 * scopes. Older Gateways may omit either metadata surface, so only explicit
 * method absence or an explicit insufficient scope blocks the action.
 */
export function canCallGatewayMethod(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> | null | undefined,
  method: string,
  requiredScope: GatewayMethodOperatorScope,
  options: { requireAdvertisement?: boolean } = {},
): boolean {
  if (!snapshot?.client || snapshot.phase !== "connected") {
    return false;
  }
  const advertised = isGatewayMethodAdvertised(snapshot, method);
  const serverAuthorizesAdvertisedMethods =
    isGatewayCapabilityAdvertised(snapshot, CONTROL_UI_SERVER_AUTHORIZED_METHODS_CAPABILITY) ===
    true;
  if (
    (serverAuthorizesAdvertisedMethods && advertised !== true) ||
    (options.requireAdvertisement !== false && advertised === false)
  ) {
    return false;
  }
  // The proxy owns resource authorization; this capability applies only to its
  // explicit catalog, so it never enables an unadvertised administrative method.
  if (serverAuthorizesAdvertisedMethods && advertised === true) {
    return true;
  }
  const auth = snapshot.hello?.auth ?? null;
  return (
    !auth?.scopes ||
    roleScopesAllow({
      role: auth.role ?? "operator",
      requestedScopes: [requiredScope],
      allowedScopes: auth.scopes,
    })
  );
}
