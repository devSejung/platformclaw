import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { isGatewayCapabilityAdvertised, isGatewayMethodAdvertised } from "./gateway-methods.ts";

export const PLATFORMCLAW_PERSONAL_VM_TERMINAL_CAPABILITY = "platformclaw.personal-vm-terminal";

export function isTerminalAvailable(
  snapshot: ApplicationGatewaySnapshot,
  terminalEnabled: boolean,
): boolean {
  return (
    snapshot.phase === "connected" &&
    terminalEnabled &&
    (hasOperatorAdminAccess(snapshot.hello?.auth ?? null) ||
      isGatewayCapabilityAdvertised(snapshot, PLATFORMCLAW_PERSONAL_VM_TERMINAL_CAPABILITY) ===
        true) &&
    (isGatewayMethodAdvertised(snapshot, "terminal.open") ?? false)
  );
}
