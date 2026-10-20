import type {
  SafeConnectEndpoint,
  VmAdministrationSnapshot as AdministrationSnapshot,
  VmHost as Host,
} from "../../../packages/platformclaw-control-plane/src/execution-contracts.js";
import type { SafeConnectProbeResult } from "../../../packages/platformclaw-control-plane/src/safeconnect-probe.js";

export type VmAdminEndpoint = Pick<
  SafeConnectEndpoint,
  "id" | "label" | "host" | "port" | "adDomain" | "status" | "hostKeyFingerprint"
>;
export type VmAdminHost = Pick<
  Host,
  "id" | "endpointId" | "label" | "targetAddress" | "status" | "executionEnvironment"
>;
export type VmAdminAllocation = AdministrationSnapshot["allocations"][number];
export type VmAdminProbe = SafeConnectProbeResult;
export type VmAdminSnapshot = {
  endpoints: VmAdminEndpoint[];
  hosts: VmAdminHost[];
  allocations: VmAdminAllocation[];
  auditEvents: {
    id: string;
    eventType: string;
    targetType: string;
    targetId: string;
    createdAt: number;
  }[];
  probe?: VmAdminProbe;
};
export type VmAdminTab = "hosts" | "endpoints" | "allocations" | "audit";
export type VmEnvironmentDraft = { pathPrepend: string; environmentVariables: string };
export type VmHostDraft = VmEnvironmentDraft & {
  endpointId: string;
  label: string;
  targetAddress: string;
};
export type VmEndpointDraft = {
  endpointId?: string;
  persisted?: boolean;
  label: string;
  host: string;
  port: number;
  adDomain: string;
};
export type VmAdminMutation = {
  action:
    | "disable-endpoint"
    | "enable-endpoint"
    | "disable-host"
    | "enable-host"
    | "revoke-allocation";
  fieldName: "endpointId" | "vmHostId" | "allocationId";
  id: string;
  label: string;
};
export type VmAdminDialog =
  | { kind: "host"; hostId: string | null; draft: VmHostDraft }
  | { kind: "environment"; host: VmAdminHost; draft: VmEnvironmentDraft }
  | { kind: "endpoint"; draft: VmEndpointDraft; probe: VmAdminProbe | null }
  | { kind: "confirmation"; mutation: VmAdminMutation };
export type VmAdminStage =
  | "probe"
  | "save-endpoint"
  | "recover-endpoint"
  | "approve-key"
  | "save-host"
  | "save-environment"
  | "change-status";
export type VmAdminOperation =
  | { kind: "idle" }
  | { kind: "review" }
  | { kind: "working"; stage: VmAdminStage }
  | { kind: "success"; stage: VmAdminStage }
  | { kind: "error"; stage: VmAdminStage; error: string };

export function vmEnvironmentDraft(host?: VmAdminHost): VmEnvironmentDraft {
  return {
    pathPrepend: host?.executionEnvironment?.pathPrepend.join("\n") ?? "",
    environmentVariables: Object.entries(host?.executionEnvironment?.variables ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  };
}

export function vmEnvironmentPayload(
  draft: VmEnvironmentDraft,
): NonNullable<Host["executionEnvironment"]> {
  return {
    pathPrepend: draft.pathPrepend
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean),
    variables: Object.fromEntries(
      draft.environmentVariables
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=");
          return separator < 1
            ? [line, ""]
            : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
        }),
    ),
  };
}

export function vmFormString(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function vmHostEditBlock(
  snapshot: VmAdminSnapshot,
  host: VmAdminHost,
): "disableHostFirst" | "revokeBeforeEdit" | "noEnabledEndpoint" | null {
  if (host.status === "active") {
    return "disableHostFirst";
  }
  if (
    snapshot.allocations.some(
      (allocation) => allocation.vmHostId === host.id && allocation.status !== "revoked",
    )
  ) {
    return "revokeBeforeEdit";
  }
  return snapshot.endpoints.some((endpoint) => endpoint.status === "active")
    ? null
    : "noEnabledEndpoint";
}

export function vmMutationBlock(
  snapshot: VmAdminSnapshot,
  mutation: VmAdminMutation,
): "disableHostsFirst" | "revokeBeforeDisable" | "hostEditRequiresActiveEndpoint" | null {
  if (
    mutation.action === "disable-endpoint" &&
    snapshot.hosts.some((host) => host.endpointId === mutation.id && host.status === "active")
  ) {
    return "disableHostsFirst";
  }
  if (
    mutation.action === "disable-host" &&
    snapshot.allocations.some(
      (allocation) => allocation.vmHostId === mutation.id && allocation.status !== "revoked",
    )
  ) {
    return "revokeBeforeDisable";
  }
  if (mutation.action === "enable-host") {
    const host = snapshot.hosts.find((candidate) => candidate.id === mutation.id);
    if (
      !snapshot.endpoints.some(
        (endpoint) => endpoint.id === host?.endpointId && endpoint.status === "active",
      )
    ) {
      return "hostEditRequiresActiveEndpoint";
    }
  }
  return null;
}
