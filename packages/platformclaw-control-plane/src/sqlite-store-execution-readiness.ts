type AssignedVmExecutionFields = {
  remote_home_dir: string | null;
  remote_workspace_dir: string | null;
  host_key_algorithm: string | null;
  host_key_public_key: string | null;
  host_key_fingerprint: string | null;
};

type AssignedVmHostKeyFields = {
  host_key_algorithm: string;
  host_key_public_key: string;
  host_key_fingerprint: string;
};

type AssignedVmRuntimeFields = AssignedVmHostKeyFields & {
  remote_home_dir: string;
  remote_workspace_dir: string;
};

type AssignedVmReadyFields = AssignedVmExecutionFields & {
  agent_binding_id: string;
  allocation_status: string;
  host_status: string;
  endpoint_status: string;
  credential_status: string | null;
  credential_revision: number | null;
};

export function hasCompleteAssignedVmExecutionFields<T extends AssignedVmExecutionFields>(
  fields: T,
  requireRuntimePaths: true,
): fields is T & AssignedVmRuntimeFields;
export function hasCompleteAssignedVmExecutionFields<T extends AssignedVmExecutionFields>(
  fields: T,
  requireRuntimePaths: false,
): fields is T & AssignedVmHostKeyFields;
export function hasCompleteAssignedVmExecutionFields(
  fields: AssignedVmExecutionFields,
  requireRuntimePaths: boolean,
): boolean {
  return Boolean(
    fields.host_key_algorithm &&
    fields.host_key_public_key &&
    fields.host_key_fingerprint &&
    (!requireRuntimePaths ||
      (fields.remote_home_dir && fields.remote_home_dir !== "/" && fields.remote_workspace_dir)),
  );
}

export function isReadyAssignedVmExecutionRow<T extends AssignedVmReadyFields>(
  fields: T | undefined,
  expectedBindingId: string,
): fields is T & AssignedVmRuntimeFields & { credential_revision: number } {
  return Boolean(
    fields &&
    fields.agent_binding_id === expectedBindingId &&
    fields.allocation_status === "ready" &&
    fields.host_status === "active" &&
    fields.endpoint_status === "active" &&
    fields.credential_status === "current" &&
    typeof fields.credential_revision === "number" &&
    Number.isSafeInteger(fields.credential_revision) &&
    fields.credential_revision >= 1 &&
    hasCompleteAssignedVmExecutionFields(fields, true),
  );
}
