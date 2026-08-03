import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import { ControlPlaneStateError } from "./contracts.js";
import type { CredentialBrokerGrant } from "./credential-broker-grants.js";
import type {
  AssignedVmExecutionTarget,
  ControlPlaneExecutionTargetStore,
  ExecutionTarget,
  PersonalExecutionTarget,
} from "./execution-contracts.js";

export type ExecutionTargetSnapshot =
  | {
      kind: "platform_server";
      agentId: string;
      targetId: "platform-server";
      revision: number;
    }
  | Omit<AssignedVmExecutionTarget, "userId">;

export type ExecutionCredentialGrant = CredentialBrokerGrant & {
  brokerAddress: string;
  agentId: string;
  allocationId: string;
  targetRevision: number;
  credentialRevision: number;
};

export type ExecutionCredentialGrantIssuer = {
  readonly address: string;
  issueForUser(userId: string, validate?: () => Promise<void>): CredentialBrokerGrant;
};

function requireAgentId(agentId: string): string {
  const normalized = agentId.trim();
  if (!isValidAgentId(normalized) || normalized !== normalized.toLowerCase()) {
    throw new ControlPlaneStateError("execution handoff agent id is invalid");
  }
  return normalized;
}

function publicSnapshot(target: ExecutionTarget): ExecutionTargetSnapshot {
  if (target.kind === "platform_server") {
    return {
      kind: target.kind,
      agentId: target.agentId,
      targetId: target.targetId,
      revision: target.revision,
    };
  }
  return {
    kind: target.kind,
    agentId: target.agentId,
    targetId: target.targetId,
    revision: target.revision,
    allocationId: target.allocationId,
    credentialRevision: target.credentialRevision,
    vmLabel: target.vmLabel,
    safeConnectLabel: target.safeConnectLabel,
    endpointHost: target.endpointHost,
    endpointPort: target.endpointPort,
    adDomain: target.adDomain,
    adAccount: target.adAccount,
    targetAddress: target.targetAddress,
    linuxAccount: target.linuxAccount,
    remoteHomeDir: target.remoteHomeDir,
    remoteWorkspaceDir: target.remoteWorkspaceDir,
    hostKeyAlgorithm: target.hostKeyAlgorithm,
    hostKeyPublicKey: target.hostKeyPublicKey,
    hostKeyFingerprint: target.hostKeyFingerprint,
  };
}

function assertSameVmTarget(
  target: PersonalExecutionTarget,
  expected: {
    agentId: string;
    allocationId: string;
    targetRevision: number;
    credentialRevision: number;
  },
): asserts target is AssignedVmExecutionTarget {
  if (
    target.kind !== "assigned_vm" ||
    target.agentId !== expected.agentId ||
    target.allocationId !== expected.allocationId ||
    target.revision !== expected.targetRevision ||
    target.credentialRevision !== expected.credentialRevision
  ) {
    throw new ControlPlaneStateError("execution target changed before credential redemption");
  }
}

export class ExecutionHandoffService {
  constructor(
    private readonly store: ControlPlaneExecutionTargetStore,
    private readonly credentialBroker: ExecutionCredentialGrantIssuer,
  ) {}

  async resolveTarget(agentId: string): Promise<ExecutionTargetSnapshot> {
    return publicSnapshot(await this.store.resolveExecutionTarget(requireAgentId(agentId)));
  }

  async resolveConnectionTarget(agentId: string) {
    const target = await this.store.resolveAssignedVmConnectionTarget(requireAgentId(agentId));
    // Connection snapshots are probe-only: the remote command discovers canonical
    // paths before selection. Executable target resolution never receives these sentinels.
    return publicSnapshot({
      ...target,
      credentialRevision: 0,
      remoteHomeDir: target.remoteHomeDir ?? "/",
      remoteWorkspaceDir: target.remoteWorkspaceDir ?? "/",
    });
  }

  async changeTarget(params: {
    agentId: string;
    target: "platform_server" | "assigned_vm";
    expectedRevision: number;
    changedAt: number;
  }): Promise<ExecutionTargetSnapshot> {
    if (
      !Number.isSafeInteger(params.expectedRevision) ||
      params.expectedRevision < 0 ||
      !Number.isSafeInteger(params.changedAt) ||
      params.changedAt < 1
    ) {
      throw new ControlPlaneStateError("execution target change is invalid");
    }
    return publicSnapshot(
      await this.store.changePersonalExecutionTarget({
        ...params,
        agentId: requireAgentId(params.agentId),
      }),
    );
  }

  async issueCredentialGrant(params: {
    agentId: string;
    allocationId: string;
    targetRevision: number;
    credentialRevision: number;
  }): Promise<ExecutionCredentialGrant> {
    const expected = {
      agentId: requireAgentId(params.agentId),
      allocationId: params.allocationId.trim(),
      targetRevision: params.targetRevision,
      credentialRevision: params.credentialRevision,
    };
    if (
      !expected.allocationId ||
      !Number.isSafeInteger(expected.targetRevision) ||
      expected.targetRevision < 0 ||
      !Number.isSafeInteger(expected.credentialRevision) ||
      expected.credentialRevision < 1
    ) {
      throw new ControlPlaneStateError("credential grant target is invalid");
    }
    const target = await this.store.resolvePersonalExecutionTarget(expected.agentId);
    assertSameVmTarget(target, expected);
    const grant = this.credentialBroker.issueForUser(target.userId, async () => {
      const current = await this.store.resolvePersonalExecutionTarget(expected.agentId);
      assertSameVmTarget(current, expected);
    });
    return {
      ...grant,
      brokerAddress: this.credentialBroker.address,
      agentId: target.agentId,
      allocationId: target.allocationId,
      targetRevision: target.revision,
      credentialRevision: target.credentialRevision,
    };
  }
}
