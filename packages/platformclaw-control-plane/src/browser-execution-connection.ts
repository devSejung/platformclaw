import { GatewayAdminRpcError } from "./gateway-admin-rpc-client.js";

export type ConnectionTestResult = {
  allocationId: string;
  targetRevision: number;
  remoteHomeDir: string;
  remoteWorkspaceDir: string;
};

export function connectionTestResult(value: unknown): ConnectionTestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("development VM returned an invalid connection result");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.remoteHomeDir !== "string" ||
    !result.remoteHomeDir.startsWith("/") ||
    typeof result.remoteWorkspaceDir !== "string" ||
    !result.remoteWorkspaceDir.startsWith(`${result.remoteHomeDir}/`) ||
    typeof result.allocationId !== "string" ||
    !result.allocationId.trim() ||
    typeof result.targetRevision !== "number" ||
    !Number.isSafeInteger(result.targetRevision) ||
    result.targetRevision < 0
  ) {
    throw new Error("development VM returned an invalid connection result");
  }
  return {
    allocationId: result.allocationId,
    targetRevision: result.targetRevision,
    remoteHomeDir: result.remoteHomeDir,
    remoteWorkspaceDir: result.remoteWorkspaceDir,
  };
}

export function vmConnectionFailureKind(error: unknown): string | null {
  if (!(error instanceof GatewayAdminRpcError)) {
    return null;
  }
  const details = error.details;
  const kind =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>).kind
      : undefined;
  return typeof kind === "string" && kind.startsWith("vm_") ? kind : null;
}

export function isVmAuthenticationFailure(error: unknown): boolean {
  return vmConnectionFailureKind(error) === "vm_authentication_failed";
}
