import type { AssignedVmTargetSnapshot } from "./execution-target.types.js";

/** Every input that identifies the account, authority, and pinned SSH endpoint. */
export function leaseIdentity(target: AssignedVmTargetSnapshot): string {
  return JSON.stringify([
    target.agentId,
    target.allocationId,
    target.revision,
    target.credentialRevision,
    target.endpointHost,
    target.endpointPort,
    target.adDomain,
    target.adAccount,
    target.targetAddress,
    target.linuxAccount,
    target.hostKeyAlgorithm,
    target.hostKeyPublicKey,
    target.hostKeyFingerprint,
  ]);
}
