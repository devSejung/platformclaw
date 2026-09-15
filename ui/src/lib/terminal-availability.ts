import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { isGatewayCapabilityAdvertised, isGatewayMethodAdvertised } from "./gateway-methods.ts";

const PLATFORMCLAW_PERSONAL_VM_TERMINAL_CAPABILITY = "platformclaw.personal-vm-terminal";

export function isPersonalVmTerminalSession(snapshot: ApplicationGatewaySnapshot): boolean {
  return (
    isGatewayCapabilityAdvertised(snapshot, PLATFORMCLAW_PERSONAL_VM_TERMINAL_CAPABILITY) === true
  );
}

export function isTerminalAvailable(
  snapshot: ApplicationGatewaySnapshot,
  terminalEnabled: boolean,
): boolean {
  return (
    snapshot.phase === "connected" &&
    terminalEnabled &&
    (hasOperatorAdminAccess(snapshot.hello?.auth ?? null) ||
      isPersonalVmTerminalSession(snapshot)) &&
    (isGatewayMethodAdvertised(snapshot, "terminal.open") ?? false)
  );
}
