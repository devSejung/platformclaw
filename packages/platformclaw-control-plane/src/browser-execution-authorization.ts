import type { BrowserAuthService } from "./browser-auth-service.js";
import { EmployeeExecutionHttpError } from "./browser-execution-errors.js";
import type { AssignedVmConnectionTarget } from "./execution-contracts.js";

export function assertCurrentVmCandidate(
  expected: AssignedVmConnectionTarget,
  current: AssignedVmConnectionTarget,
): void {
  const identityFields = [
    "agentId",
    "userId",
    "revision",
    "allocationId",
    "endpointHost",
    "endpointPort",
    "adDomain",
    "adAccount",
    "targetAddress",
    "linuxAccount",
    "hostKeyAlgorithm",
    "hostKeyPublicKey",
    "hostKeyFingerprint",
  ] as const;
  if (identityFields.some((field) => expected[field] !== current[field])) {
    throw new EmployeeExecutionHttpError(409, "VM authorization changed; reload and reconnect");
  }
}

export async function requireVmCredentialBrowserAuthority(
  authService: BrowserAuthService,
  params: { userId: string; agentId: string; sessionToken: string },
  expected?: { session: { id: string }; binding: { id: string } },
) {
  const auth = await authService.authenticateToken(params.sessionToken, false);
  if (
    auth.status !== "active" ||
    auth.user.id !== params.userId ||
    auth.binding.state !== "active" ||
    auth.binding.agentId !== params.agentId ||
    (expected &&
      (auth.session.id !== expected.session.id || auth.binding.id !== expected.binding.id))
  ) {
    throw new EmployeeExecutionHttpError(401, "authentication required");
  }
  return auth;
}
