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
