import type {
  AgentProvisioningState,
  ManagedScopeKind,
  ManagedScopeRole,
  OrganizationMemoryClaimStatus,
  OrganizationMemoryPromotionSourceKind,
  OrganizationMemoryScopeKind,
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

type DirectoryGroupRow = { user_id: string; group_name: string };
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
  parent_scope_id: string | null;
  system_kind: "unassigned-team" | null;
  system_provenance: "migration-v2-v3" | null;
  status: "active" | "archived";
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
};
type ManagedScopePrimaryMembershipRow = {
  user_id: string;
  scope_id: string;
  updated_at: number;
};
type OrganizationJoinRequestRow = {
  id: string;
  user_id: string;
  scope_id: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  created_at: number;
  decided_at: number | null;
};
type OrganizationJoinRequestDecisionRow = {
  request_id: string;
  decision: "approved" | "rejected" | "cancelled";
  actor_user_id: string;
  reason: string;
  decided_at: number;
};
export type ManagedScopeMembershipRow = {
  scope_id: string;
  user_id: string;
  role: ManagedScopeRole;
  created_at: number;
  updated_at: number;
};
export type OrganizationMemoryPageRow = {
  id: string;
  scope_kind: OrganizationMemoryScopeKind;
  scope_id: string | null;
  title: string;
  content: string;
  provenance_json: string;
  revision: number;
  status: "active" | "retired";
  created_at: number;
  updated_at: number;
};
export type OrganizationMemoryPromotionRequestRow = {
  id: string;
  source_kind: OrganizationMemoryPromotionSourceKind;
  source_scope_id: string | null;
  source_claim_id: string;
  source_revision: number;
  target_kind: OrganizationMemoryScopeKind;
  target_scope_id: string | null;
  proposed_text: string;
  evidence_json: string;
  reason: string;
  requested_by_user_id: string;
  created_at: number;
};
export type OrganizationMemoryClaimRow = {
  id: string;
  scope_kind: OrganizationMemoryScopeKind;
  scope_id: string | null;
  title: string;
  claim_text: string;
  evidence_json: string;
  source_kind: OrganizationMemoryPromotionSourceKind;
  source_scope_id: string | null;
  source_claim_id: string;
  source_revision: number;
  promotion_request_id: string;
  revision: number;
  status: OrganizationMemoryClaimStatus;
  created_by_user_id: string;
  approved_by_user_id: string;
  created_at: number;
  updated_at: number;
  retired_by_user_id: string | null;
  retired_at: number | null;
  retirement_reason: string | null;
};
export type OrganizationMemoryPromotionDecisionRow = {
  id: string;
  request_id: string;
  decision: "approved" | "rejected";
  decided_by_user_id: string;
  reason: string;
  target_claim_id: string | null;
  decided_at: number;
};
type AuditEventRow = {
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

type VmHostExecutionEnvironmentRow = {
  vm_host_id: string;
  config_json: string;
  updated_by_user_id: string;
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

type PersonalExecutionProfileRow = {
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

export type EncryptedUserMcpCredentialRow = {
  user_id: string;
  server_name: string;
  kind: "bearer" | "api_key" | "oauth";
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
  key_id: string;
  format_version: number;
  revision: number;
  created_at: number;
  updated_at: number;
};

type ExecCredentialDefinitionRow = {
  env_name: string;
  created_by_user_id: string;
  created_at: number;
};

export type EncryptedUserExecCredentialRow = {
  user_id: string;
  env_name: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
  key_id: string;
  format_version: number;
  revision: number;
  created_at: number;
  updated_at: number;
};

type McpOAuthStateRow = {
  state_hash: string;
  user_id: string;
  server_name: string;
  expires_at: number;
  created_at: number;
};

export type SkillHubOwnershipRow = {
  namespace: string;
  slug: string;
  owner_user_id: string | null;
  previous_owner_user_id: string | null;
  visibility: "PUBLIC" | "NAMESPACE_ONLY" | "PRIVATE";
  current_version: string;
  updated_at: number;
};

export type SkillHubAccessRow = {
  namespace: string;
  slug: string;
  user_id: string;
  granted_by_user_id: string;
  expires_at: number | null;
  inherit_versions: number;
  granted_version: string | null;
  created_at: number;
  updated_at: number;
};

export type SkillHubNotificationRow = {
  id: string;
  user_id: string;
  kind: string;
  namespace: string | null;
  slug: string | null;
  message: string;
  created_at: number;
  read_at: number | null;
};

type SkillHubGovernanceJobRow = {
  namespace: string;
  slug: string;
  version: string;
  owner_user_id: string | null;
  state: "pending" | "approved" | "blocked" | "failed";
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  updated_at: number;
};

export type SkillHubNamespaceBindingRow = {
  namespace: string;
  scope_kind: "global" | "team" | "group" | "part";
  scope_id: string | null;
  visibility_ceiling: "PUBLIC" | "NAMESPACE_ONLY" | "PRIVATE";
  access_state: "active" | "restricted";
  created_by_user_id: string;
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
  managed_scope_primary_memberships: ManagedScopePrimaryMembershipRow;
  organization_join_requests: OrganizationJoinRequestRow;
  organization_join_request_decisions: OrganizationJoinRequestDecisionRow;
  organization_memory_pages: OrganizationMemoryPageRow;
  organization_memory_claims: OrganizationMemoryClaimRow;
  organization_memory_promotion_requests: OrganizationMemoryPromotionRequestRow;
  organization_memory_promotion_decisions: OrganizationMemoryPromotionDecisionRow;
  control_audit_events: AuditEventRow;
  safeconnect_endpoints: SafeConnectEndpointRow;
  vm_hosts: VmHostRow;
  vm_host_execution_environments: VmHostExecutionEnvironmentRow;
  vm_allocations: VmAllocationRow;
  personal_execution_profiles: PersonalExecutionProfileRow;
  encrypted_user_ssh_credentials: EncryptedUserSshCredentialRow;
  encrypted_user_mcp_credentials: EncryptedUserMcpCredentialRow;
  exec_credential_definitions: ExecCredentialDefinitionRow;
  encrypted_user_exec_credentials: EncryptedUserExecCredentialRow;
  mcp_oauth_states: McpOAuthStateRow;
  skill_hub_skill_ownership: SkillHubOwnershipRow;
  skill_hub_skill_access: SkillHubAccessRow;
  skill_hub_notifications: SkillHubNotificationRow;
  skill_hub_governance_jobs: SkillHubGovernanceJobRow;
  skill_hub_namespace_bindings: SkillHubNamespaceBindingRow;
};
