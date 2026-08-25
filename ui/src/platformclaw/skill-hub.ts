import { PLATFORMCLAW_SKILL_HUB_API_PATH } from "./web-contract.ts";

export type PlatformClawSkillHubConfig = {
  namespaces: string[];
  maxPackageBytes: number;
  maxUploadBytes?: number;
  activeTarget?: PlatformClawSkillHubWorkspaceTarget;
  capabilities?: {
    scanner: boolean;
    forcePublish: boolean;
    ownerTransfer: boolean;
    accessControl: boolean;
    notifications: boolean;
    zipUpload: boolean;
  };
  installTargets?: Array<{
    target: PlatformClawSkillHubWorkspaceTarget;
    available: boolean;
    status: string;
    disabledReason?: string;
  }>;
  admin?: boolean;
  notifications?: { unreadCount: number };
  unassignedOwnerCount?: number;
};

export type PlatformClawSkillHubWorkspaceTarget = "platform_server" | "assigned_vm";

export type PlatformClawSkillHubWorkspaceSkill = {
  skillKey: string;
  name?: string;
  description?: string;
  version?: string;
  revision?: string;
};

export type PlatformClawSkillHubSearchItem = {
  namespace: string;
  slug: string;
  latestVersion: string;
  summary: string;
};

type PlatformClawSkillHubVersion = {
  version: string;
  status: string;
  changelog?: string;
  fileCount?: number;
  totalSize?: number;
  publishedAt?: string;
  downloadAvailable: boolean;
};

export type PlatformClawSkillHubDetail = {
  skill: {
    namespace: string;
    slug: string;
    displayName: string;
    summary: string;
    visibility: "PUBLIC" | "NAMESPACE_ONLY" | "PRIVATE";
    status: string;
    downloadCount?: number;
    starCount?: number;
    ratingAvg?: number;
    ratingCount?: number;
  };
  versions: PlatformClawSkillHubVersion[];
  owner?: {
    assigned: boolean;
    isMine: boolean;
    unassigned: boolean;
    revision?: number;
    user?: { id: string; accountId: string; displayName?: string };
  } | null;
  scanner?: {
    version?: string;
    status: "not_available" | "pending" | "passed" | "failed";
    badge: string;
    current: true;
  };
  canManage?: boolean;
  access?: PlatformClawSkillHubAccessGrant[];
};

type PlatformClawSkillHubAccessGrant = {
  userId: string;
  expiresAt: number | null;
  inheritVersions: boolean;
  grantedVersion: string | null;
};

export type PlatformClawSkillHubNotification = {
  id: string;
  kind: string;
  namespace: string | null;
  slug: string | null;
  message: string;
  createdAt: number;
  readAt: number | null;
};

export type PlatformClawSkillHubNamespaceBinding = {
  namespace: string;
  scopeKind: "global" | "team" | "group" | "part";
  accessState: "active" | "restricted";
  scopeId?: string;
  visibilityCeiling: "PUBLIC" | "NAMESPACE_ONLY" | "PRIVATE";
  createdAt: number;
  updatedAt: number;
};

export type PlatformClawManagedScope = {
  id: string;
  kind: "team" | "group" | "part";
  name: string;
  parentScopeId?: string;
};

export type PlatformClawSkillHubUnassignedSkill = {
  namespace: string;
  slug: string;
  visibility: "PUBLIC" | "NAMESPACE_ONLY" | "PRIVATE";
  currentVersion: string;
  changedAt: number;
};

export type PlatformClawSkillHubManagementUser = {
  id: string;
  accountId: string;
  displayName?: string;
};

export type PlatformClawSkillHubMessage = {
  kind: "success" | "warning" | "error";
  text: string;
};

export class PlatformClawSkillHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PlatformClawSkillHubRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${PLATFORMCLAW_SKILL_HUB_API_PATH}${path}`, {
    ...init,
    headers,
  });
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    details?: unknown;
  } | null;
  if (!response.ok) {
    throw new PlatformClawSkillHubRequestError(
      typeof body?.error === "string"
        ? body.error
        : `Skill Hub request failed (${response.status})`,
      response.status,
      body?.details && typeof body.details === "object"
        ? (body.details as Record<string, unknown>)
        : undefined,
    );
  }
  return body as T;
}

export function loadPlatformClawSkillHubConfig(): Promise<PlatformClawSkillHubConfig> {
  return request("/config");
}

export function loadPlatformClawWorkspaceSkills(
  source: PlatformClawSkillHubWorkspaceTarget,
): Promise<{
  source: PlatformClawSkillHubWorkspaceTarget;
  items: PlatformClawSkillHubWorkspaceSkill[];
}> {
  return request(`/workspace-skills?source=${encodeURIComponent(source)}`);
}

export function searchPlatformClawSkillHub(
  query: string,
): Promise<{ items: PlatformClawSkillHubSearchItem[]; total: number }> {
  return request(`/search?q=${encodeURIComponent(query)}&limit=20`);
}

export function loadPlatformClawSkillHubDetail(
  namespace: string,
  slug: string,
): Promise<PlatformClawSkillHubDetail> {
  return request(`/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`);
}

export function publishPlatformClawWorkspaceSkill(params: {
  skill: string;
  source: PlatformClawSkillHubWorkspaceTarget;
  namespace: string;
  version: string;
  visibility: string;
}): Promise<{
  namespace: string;
  slug: string;
  version: string;
  ownershipReviewRequired?: true;
}> {
  return request("/publish", { method: "POST", body: JSON.stringify(params) });
}

export function installPlatformClawHubSkill(params: {
  namespace: string;
  slug: string;
  version: string;
  destination: "platform_server" | "assigned_vm";
  acknowledgedVersionChange?: true;
  currentVersion?: string;
}): Promise<{
  ok: true;
  slug: string;
  version: string;
  target: "platform_server" | "assigned_vm";
  noOp?: boolean;
}> {
  return request("/install", { method: "POST", body: JSON.stringify(params) });
}

export function publishPlatformClawSkillArchive(
  file: File,
  params: { slug: string; namespace: string; version: string; visibility: string },
): Promise<{
  namespace: string;
  slug: string;
  version: string;
  ownershipReviewRequired?: true;
}> {
  const query = new URLSearchParams(params);
  return request(`/publish/upload?${query.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });
}

export function loadPlatformClawSkillHubNotifications(): Promise<{
  items: PlatformClawSkillHubNotification[];
  unreadCount: number;
}> {
  return request("/notifications");
}

export function markPlatformClawSkillHubNotificationsRead(ids?: string[]): Promise<{
  ok: true;
  updated: number;
}> {
  return request("/notifications/read", {
    method: "POST",
    body: JSON.stringify(ids ? { ids } : {}),
  });
}

export function transferPlatformClawSkillHubOwner(
  namespace: string,
  slug: string,
  ownerUserId: string,
  expectedOwnerUpdatedAt: number,
): Promise<{ ownerUserId: string }> {
  return request(`/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/owner`, {
    method: "POST",
    body: JSON.stringify({ ownerUserId, expectedOwnerUpdatedAt }),
  });
}

export function searchPlatformClawSkillHubManagementUsers(
  namespace: string,
  slug: string,
  query: string,
  purpose: "owner" | "access",
): Promise<{ items: PlatformClawSkillHubManagementUser[] }> {
  const params = new URLSearchParams({ q: query, purpose, limit: "20" });
  return request(
    `/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/management-users?${params.toString()}`,
  );
}

export function grantPlatformClawSkillHubAccess(
  namespace: string,
  slug: string,
  params: { userId: string; expiresAt?: number; inheritVersions: boolean; version?: string },
): Promise<PlatformClawSkillHubAccessGrant> {
  return request(`/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/access`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function removePlatformClawSkillHubAccess(
  namespace: string,
  slug: string,
  userId: string,
): Promise<{ ok: true; removed: boolean }> {
  return request(
    `/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/access/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
}

export function forcePublishPlatformClawHubSkill(
  namespace: string,
  slug: string,
  params: { version: string; acknowledged: true; reason: string },
): Promise<{
  acknowledged: true;
  version: string;
  upstreamOverridePerformed: boolean;
  ownershipReviewRequired?: true;
}> {
  return request(`/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/force`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function loadPlatformClawSkillHubNamespaceBindings(): Promise<{
  bindings: PlatformClawSkillHubNamespaceBinding[];
  scopes: PlatformClawManagedScope[];
}> {
  return request("/admin/namespaces");
}

export function setPlatformClawSkillHubNamespaceBinding(params: {
  namespace: string;
  scopeKind: "global" | "team" | "group" | "part";
  scopeId?: string;
  visibilityCeiling: "PUBLIC" | "NAMESPACE_ONLY" | "PRIVATE";
  expectedUpdatedAt: number | null;
  reason: string;
}): Promise<PlatformClawSkillHubNamespaceBinding> {
  return request("/admin/namespaces", { method: "POST", body: JSON.stringify(params) });
}

export function removePlatformClawSkillHubNamespaceBinding(
  namespace: string,
  params: { expectedUpdatedAt: number; reason: string },
): Promise<{ ok: true; removed: boolean }> {
  return request(`/admin/namespaces/${encodeURIComponent(namespace)}`, {
    method: "DELETE",
    body: JSON.stringify(params),
  });
}

export function setPlatformClawSkillHubNamespaceAccessState(
  namespace: string,
  params: { accessState: "active" | "restricted"; expectedUpdatedAt: number; reason: string },
): Promise<PlatformClawSkillHubNamespaceBinding> {
  return request(`/admin/namespaces/${encodeURIComponent(namespace)}/access-state`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function loadPlatformClawSkillHubUnassignedSkills(): Promise<{
  items: PlatformClawSkillHubUnassignedSkill[];
}> {
  return request("/admin/unassigned");
}
