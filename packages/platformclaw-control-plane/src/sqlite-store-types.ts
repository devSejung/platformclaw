import type {
  AgentProvisioningState,
  ManagedScopeKind,
  ManagedScopeRole,
  PlatformUserGlobalRole,
  PlatformUserStatus,
} from "./contracts.js";

export type PlatformUserRow = {
  id: string;
  account_id: string;
  employee_id: string;
  display_name: string | null;
  email: string | null;
  department: string | null;
  timezone: string | null;
  status: PlatformUserStatus;
  global_role: PlatformUserGlobalRole;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
};

export type EnterpriseIdentityRow = {
  provider: "ldap" | "saml";
  subject: string;
  user_id: string;
  employee_id: string;
  created_at: number;
  last_authenticated_at: number;
};

export type DirectoryGroupRow = { user_id: string; group_name: string };
export type AgentBindingRow = {
  id: string;
  kind: "personal" | "knox-room";
  user_id: string | null;
  knox_account_id: string | null;
  room_id: string | null;
  agent_id: string;
  state: AgentProvisioningState;
  failure_code: string | null;
  created_at: number;
  updated_at: number;
};
export type BrowserSessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  idle_expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
};
export type ManagedScopeRow = {
  id: string;
  kind: ManagedScopeKind;
  name: string;
  normalized_name: string;
  parent_group_id: string | null;
  status: "active" | "archived";
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
};
export type ManagedScopeMembershipRow = {
  scope_id: string;
  user_id: string;
  role: ManagedScopeRole;
  created_at: number;
  updated_at: number;
};
export type AuditEventRow = {
  id: string;
  actor_user_id: string | null;
  event_type: string;
  target_type: string;
  target_id: string;
  details_json: string | null;
  created_at: number;
};

export type SafeConnectEndpointRow = {
  id: string;
  label: string;
  host: string;
  port: number;
  ad_domain: string;
  status: "pending" | "active" | "disabled";
  host_key_algorithm: string | null;
  host_key_public_key: string | null;
  host_key_fingerprint: string | null;
  host_key_approved_by_user_id: string | null;
  host_key_approved_at: number | null;
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
};

export type VmHostRow = {
  id: string;
  endpoint_id: string;
  label: string;
  target_address: string;
  status: "active" | "disabled";
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
};

export type VmAllocationRow = {
  id: string;
  agent_binding_id: string;
  vm_host_id: string;
  linux_account: string;
  status: "assigned" | "ready" | "connection_required" | "revoked";
  remote_home_dir: string | null;
  remote_workspace_dir: string | null;
  last_connection_check_at: number | null;
  last_connection_succeeded_at: number | null;
  failure_code: string | null;
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
};

export type PersonalExecutionProfileRow = {
  agent_binding_id: string;
  active_target: "platform_server" | "assigned_vm";
  active_allocation_id: string | null;
  target_revision: number;
  updated_at: number;
};

export type EncryptedUserSshCredentialRow = {
  id: string;
  user_id: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
  key_id: string;
  format_version: number;
  revision: number;
  status: "current" | "update_required";
  last_auth_failure_at: number | null;
  created_at: number;
  updated_at: number;
};

export type ControlPlaneDatabase = {
  platform_users: PlatformUserRow;
  enterprise_identities: EnterpriseIdentityRow;
  user_directory_groups: DirectoryGroupRow;
  agent_bindings: AgentBindingRow;
  browser_sessions: BrowserSessionRow;
  managed_scopes: ManagedScopeRow;
  managed_scope_memberships: ManagedScopeMembershipRow;
  control_audit_events: AuditEventRow;
  safeconnect_endpoints: SafeConnectEndpointRow;
  vm_hosts: VmHostRow;
  vm_allocations: VmAllocationRow;
  personal_execution_profiles: PersonalExecutionProfileRow;
  encrypted_user_ssh_credentials: EncryptedUserSshCredentialRow;
};
