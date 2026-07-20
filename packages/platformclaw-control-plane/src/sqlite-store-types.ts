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

export type ControlPlaneDatabase = {
  platform_users: PlatformUserRow;
  enterprise_identities: EnterpriseIdentityRow;
  user_directory_groups: DirectoryGroupRow;
  agent_bindings: AgentBindingRow;
  browser_sessions: BrowserSessionRow;
  managed_scopes: ManagedScopeRow;
  managed_scope_memberships: ManagedScopeMembershipRow;
  control_audit_events: AuditEventRow;
};
