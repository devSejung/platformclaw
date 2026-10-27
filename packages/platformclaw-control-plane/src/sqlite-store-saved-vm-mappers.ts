import type { PersonalSavedVmConnection } from "./execution-contracts.js";
import type { SavedVmConnectionRow } from "./sqlite-store-types.js";

export type SavedVmConnectionViewRow = SavedVmConnectionRow & {
  vm_label: string;
  safeconnect_label: string;
  host_status: string;
  endpoint_status: string;
  host: string;
  port: number;
  ad_domain: string;
  host_key_algorithm: string | null;
  host_key_public_key: string | null;
  host_key_fingerprint: string | null;
  target_address: string;
};

export function rowToSavedVmConnection(
  row: SavedVmConnectionViewRow,
  activeAllocationId: string | null,
): PersonalSavedVmConnection {
  const identity = JSON.stringify([
    row.host,
    row.port,
    row.ad_domain,
    row.host_key_algorithm,
    row.host_key_public_key,
    row.host_key_fingerprint,
    row.target_address,
  ]);
  const unavailable = row.host_status !== "active" || row.endpoint_status !== "active";
  const requiresConnection =
    row.connection_status !== "ready" ||
    row.credential_status !== "current" ||
    !row.remote_home_dir ||
    !row.remote_workspace_dir ||
    row.endpoint_identity !== identity;
  return {
    id: row.id,
    revision: row.revision,
    vmHostId: row.vm_host_id,
    vmLabel: row.vm_label,
    safeConnectLabel: row.safeconnect_label,
    linuxAccount: row.linux_account,
    status: unavailable ? "unavailable" : requiresConnection ? "connection_required" : "ready",
    active: row.allocation_id !== null && row.allocation_id === activeAllocationId,
    ...(row.remote_home_dir ? { remoteHomeDir: row.remote_home_dir } : {}),
    ...(row.remote_workspace_dir ? { remoteWorkspaceDir: row.remote_workspace_dir } : {}),
    ...(row.last_connection_succeeded_at === null
      ? {}
      : { lastConnectionSucceededAt: row.last_connection_succeeded_at }),
    ...(row.endpoint_identity !== identity
      ? { failureCode: "vm_configuration_changed" }
      : row.failure_code
        ? { failureCode: row.failure_code }
        : {}),
  };
}
