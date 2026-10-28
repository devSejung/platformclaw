import { t } from "../i18n/index.ts";
import { PLATFORMCLAW_SKILL_HUB_API_PATH } from "./web-contract.ts";

export type PlatformClawSkillHubWorkspaceTarget = "platform_server" | "assigned_vm";
export type PlatformClawSkillHubSharingMode = "PUBLIC" | "SELECTED" | "PRIVATE";
export type PlatformClawSkillHubUser = { id: string; accountId: string; displayName?: string };
export type PlatformClawManagedScope = {
  id: string;
  kind: "team" | "group" | "part";
  name: string;
  parentScopeId?: string;
};
export type PlatformClawSkillHubSharing = {
  mode: PlatformClawSkillHubSharingMode;
  userIds: string[];
  scopeIds: string[];
};
export type PlatformClawSkillHubSharingDetail = PlatformClawSkillHubSharing & {
  users: PlatformClawSkillHubUser[];
  scopes: PlatformClawManagedScope[];
};
type PlatformClawSkillHubOwner = {
  assigned: boolean;
  isMine: boolean;
  unassigned: boolean;
  revision: number;
  user?: PlatformClawSkillHubUser;
};
type PlatformClawSkillHubSkill = {
  id: string;
  slug: string;
  displayName: string;
  summary: string;
  tags: string[];
  iconUrl: string | null;
  sharing: { mode: PlatformClawSkillHubSharingMode };
  revision: number;
  latestVersion?: string;
};
export type PlatformClawSkillHubSearchItem = PlatformClawSkillHubSkill & {
  owner: PlatformClawSkillHubOwner;
};
export type PlatformClawSkillHubConfig = {
  defaultSharing: "PUBLIC";
  scopes: PlatformClawManagedScope[];
  ownedSkills: Array<Pick<PlatformClawSkillHubSkill, "id" | "slug" | "displayName" | "revision">>;
  limits: { iconBytes: number; tags: number; tagChars: number };
  maxPackageBytes: number;
  maxUploadBytes?: number;
  activeTarget?: PlatformClawSkillHubWorkspaceTarget;
  installTargets?: Array<{
    target: PlatformClawSkillHubWorkspaceTarget;
    available: boolean;
    status: string;
    disabledReason?: string;
  }>;
  capabilities?: Record<string, boolean>;
  admin?: boolean;
  notifications?: { unreadCount: number };
  unassignedOwnerCount?: number;
  maintenanceError?: string;
  pendingPublications?: Array<{
    isMine: boolean;
    displayName?: string;
    slug?: string;
    operationId: string;
    skillId: string;
    actorUserId: string;
    version: string;
    expectedRevision: number;
    state: "pending";
    createdAt: number;
    updatedAt: number;
    fingerprint: string;
  }>;
};
export type PlatformClawSkillHubWorkspaceSkill = {
  skillKey: string;
  name?: string;
  description?: string;
  version?: string;
  revision?: string;
  hubSkillId?: string;
  hubVersion?: string;
};
export type PlatformClawSkillHubWorkspaceInventory = {
  source: PlatformClawSkillHubWorkspaceTarget;
  items: PlatformClawSkillHubWorkspaceSkill[];
  // Additive rollout: older responses contain only source/items; the bundled CP
  // supplies this snapshot so mutations can pin the workspace that was displayed.
  targetId?: string;
  targetRevision?: number;
  targetLabel?: string;
};
type PlatformClawSkillHubVersion = {
  version: string;
  status: string;
  changelog?: string;
  fileCount?: number;
  totalSize?: number;
  publishedAt?: string;
  downloadAvailable: boolean;
  scanner?: {
    status: NonNullable<PlatformClawSkillHubDetail["scanner"]>["status"];
    badge: string;
    blocked?: boolean;
  };
};
export type PlatformClawSkillHubDetail = {
  skill: PlatformClawSkillHubSkill;
  versions: PlatformClawSkillHubVersion[];
  owner: PlatformClawSkillHubOwner;
  scanner?: {
    version?: string;
    status:
      | "not_available"
      | "pending"
      | "passed"
      | "failed"
      | "warning"
      | "unverified"
      | "blocked";
    badge: string;
    current: true;
  };
  canManage: boolean;
  sharing?: PlatformClawSkillHubSharingDetail;
};
export type PlatformClawSkillHubNotification = {
  id: string;
  kind: string;
  message: string;
  createdAt: number;
  readAt: number | null;
};
export type PlatformClawSkillHubHistoryItem = {
  id: string;
  action: string;
  actor: { id: string; accountId?: string; displayName?: string } | null;
  version?: string;
  createdAt: number;
  details: Record<string, unknown>;
};
export type PlatformClawSkillHubTrashItem = PlatformClawSkillHubSearchItem & {
  deletedAt: number;
  purgeAt: number;
};
export type PlatformClawSkillHubTransfer = {
  id: string;
  displayName: string;
  from: PlatformClawSkillHubUser | null;
  revision: number;
};
export type PlatformClawSkillHubMessage = { kind: "success" | "error" | "warning"; text: string };
type PlatformClawSkillHubPublication = {
  id: string;
  slug: string;
  version: string;
};
export class PlatformClawSkillHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
    readonly serverMessage: string = message,
  ) {
    super(message);
    this.name = "PlatformClawSkillHubRequestError";
  }
}

const requestErrorKeys = new Map<string, string>([
  ["skill-hub-invalid-version", "invalidVersion"],
  ["skill-hub-invalid-manifest", "invalidManifest"],
  ["skill-hub-invalid-archive", "invalidArchive"],
  ["skill-hub-version-mismatch", "versionMismatch"],
  ["skill-hub-version-exists", "versionExists"],
  ["skill-hub-vm-unassigned", "vmUnassigned"],
  ["skill-hub-vm-not-ready", "vmNotReady"],
  ["skill-hub-vm-unavailable", "vmUnavailable"],
  ["skill-hub-version-blocked", "versionBlocked"],
  ["skill-hub-version-unavailable", "versionUnavailable"],
  ["skill-hub-publication-pending", "publicationPending"],
  ["skill-hub-publication-changed", "publicationChanged"],
  ["skill-hub-publication-cancelled", "publicationCancelled"],
  ["skill-hub-publication-completed", "publicationCompleted"],
  ["skill-hub-native-identity-changed", "identityChanged"],
  ["skill-hub-changed", "changed"],
  ["skill-hub-installation-changed", "installationChanged"],
  ["existing-skill-replacement-required", "replacementRequired"],
  ["installed-version-unavailable", "installedVersionUnavailable"],
]);

function requestErrorMessage(status: number, original: string, details?: Record<string, unknown>) {
  const code = typeof details?.code === "string" ? details.code : "";
  const key =
    requestErrorKeys.get(code) ??
    (status === 0
      ? "connection"
      : status === 401
        ? "signIn"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "notFound"
            : status === 409
              ? "changed"
              : status === 413
                ? "tooLarge"
                : status === 415
                  ? "unsupportedFile"
                  : status === 400
                    ? "invalidRequest"
                    : "unavailable");
  const guidance = t(`skillHubPage.errors.${key}`);
  return original && original !== guidance
    ? `${guidance} ${t("skillHubPage.errors.details", { message: original })}`
    : guidance;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (typeof init?.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(`${PLATFORMCLAW_SKILL_HUB_API_PATH}${path}`, { ...init, headers });
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error);
    throw new PlatformClawSkillHubRequestError(
      requestErrorMessage(0, original),
      0,
      undefined,
      original,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    details?: unknown;
  } | null;
  if (!response.ok) {
    const original = typeof body?.error === "string" ? body.error : "";
    const details =
      body?.details && typeof body.details === "object"
        ? (body.details as Record<string, unknown>)
        : undefined;
    throw new PlatformClawSkillHubRequestError(
      requestErrorMessage(response.status, original, details),
      response.status,
      details,
      original,
    );
  }
  return body as T;
}
function entryPath(id: string): string {
  return `/skills/by-id/${encodeURIComponent(id)}`;
}
export function loadPlatformClawSkillHubConfig(): Promise<PlatformClawSkillHubConfig> {
  return request("/config");
}
export function loadPlatformClawWorkspaceSkills(
  source: PlatformClawSkillHubWorkspaceTarget,
): Promise<PlatformClawSkillHubWorkspaceInventory> {
  return request(`/workspace-skills?source=${encodeURIComponent(source)}`);
}
export function searchPlatformClawSkillHub(
  query: string,
): Promise<{ items: PlatformClawSkillHubSearchItem[]; total: number }> {
  return request(`/search?q=${encodeURIComponent(query)}&limit=20`);
}
export function loadPlatformClawSkillHubDetail(id: string): Promise<PlatformClawSkillHubDetail> {
  return request(entryPath(id));
}
export function resolvePlatformClawSkillHubLegacyDetail(
  namespace: string,
  slug: string,
): Promise<PlatformClawSkillHubDetail> {
  return request(`/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`);
}
export function publishPlatformClawWorkspaceSkill(params: {
  operationId: string;
  skill: string;
  source: PlatformClawSkillHubWorkspaceTarget;
  expectedTargetId?: string;
  version: string;
  id?: string;
  expectedRevision?: number;
  sharing?: PlatformClawSkillHubSharing;
  reason?: string;
}): Promise<PlatformClawSkillHubPublication> {
  return request("/publish", { method: "POST", body: JSON.stringify(params) });
}
export function publishPlatformClawSkillArchive(
  file: File,
  params: {
    operationId: string;
    slug: string;
    version: string;
    id?: string;
    expectedRevision?: number;
    sharing?: PlatformClawSkillHubSharing;
    reason?: string;
  },
): Promise<PlatformClawSkillHubPublication> {
  const query = new URLSearchParams({
    operationId: params.operationId,
    slug: params.slug,
    version: params.version,
  });
  if (params.id) {
    query.set("id", params.id);
    query.set("expectedRevision", String(params.expectedRevision));
  }
  if (params.reason) {
    query.set("reason", params.reason);
  }
  if (params.sharing) {
    query.set("sharing", JSON.stringify(params.sharing));
  }
  return request(`/publish/upload?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });
}
export function installPlatformClawHubSkill(params: {
  id: string;
  version: string;
  destination: PlatformClawSkillHubWorkspaceTarget;
  expectedTargetId?: string;
  expectedTargetRevision?: number;
  acknowledgedReplacement?: true;
  currentRevision?: string;
}): Promise<{
  ok: true;
  slug: string;
  version: string;
  target: PlatformClawSkillHubWorkspaceTarget;
}> {
  const {
    id,
    version,
    destination,
    expectedTargetId,
    expectedTargetRevision,
    acknowledgedReplacement,
    currentRevision,
  } = params;
  const body = {
    version,
    destination,
    ...(expectedTargetId !== undefined ? { expectedTargetId } : {}),
    ...(expectedTargetRevision !== undefined ? { expectedTargetRevision } : {}),
    ...(acknowledgedReplacement ? { acknowledgedReplacement } : {}),
    ...(currentRevision ? { currentRevision } : {}),
  };
  return request(`${entryPath(id)}/install`, { method: "POST", body: JSON.stringify(body) });
}
export function platformClawSkillHubDownloadUrl(id: string, version: string): string {
  return `${PLATFORMCLAW_SKILL_HUB_API_PATH}${entryPath(id)}/download?version=${encodeURIComponent(version)}`;
}
export function editPlatformClawSkillHubSkill(
  id: string,
  params: {
    expectedRevision: number;
    displayName?: string;
    summary?: string;
    tags?: string[];
    sharing?: PlatformClawSkillHubSharing;
    reason?: string;
  },
): Promise<{ ok: true }> {
  return request(entryPath(id), { method: "PATCH", body: JSON.stringify(params) });
}
export function searchPlatformClawSkillHubUsers(
  query: string,
): Promise<{ users: PlatformClawSkillHubUser[] }> {
  return request(`/users?q=${encodeURIComponent(query)}`);
}
export function deletePlatformClawSkillHubSkill(
  id: string,
  expectedRevision: number,
  reason?: string,
): Promise<{ ok: true }> {
  return request(`${entryPath(id)}/delete`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision, ...(reason ? { reason } : {}) }),
  });
}
export function restorePlatformClawSkillHubSkill(
  id: string,
  expectedRevision: number,
  reason?: string,
): Promise<{ ok: true }> {
  return request(`${entryPath(id)}/restore`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision, ...(reason ? { reason } : {}) }),
  });
}
export function loadPlatformClawSkillHubTrash(): Promise<{
  items: PlatformClawSkillHubTrashItem[];
}> {
  return request("/trash");
}
export function loadPlatformClawSkillHubHistory(
  id: string,
): Promise<{ items: PlatformClawSkillHubHistoryItem[] }> {
  return request(`${entryPath(id)}/history`);
}
export function uploadPlatformClawSkillHubIcon(
  id: string,
  expectedRevision: number,
  file: File,
  reason?: string,
): Promise<{ ok: true }> {
  return request(`${entryPath(id)}/icon?expectedRevision=${expectedRevision}`, {
    method: "PUT",
    headers: {
      "Content-Type": file.type,
      ...(reason ? { "X-Skill-Hub-Reason": encodeURIComponent(reason) } : {}),
    },
    body: file,
  });
}
export function removePlatformClawSkillHubIcon(
  id: string,
  expectedRevision: number,
  reason?: string,
): Promise<{ ok: true }> {
  return request(`${entryPath(id)}/icon?expectedRevision=${expectedRevision}`, {
    method: "DELETE",
    ...(reason ? { headers: { "X-Skill-Hub-Reason": encodeURIComponent(reason) } } : {}),
  });
}
export function loadPlatformClawSkillHubTransfers(): Promise<{
  items: PlatformClawSkillHubTransfer[];
}> {
  return request("/transfers");
}
export function transferPlatformClawSkillHubOwner(
  id: string,
  userId: string,
  expectedRevision: number,
  reason?: string,
): Promise<{ ok: true }> {
  return request(`${entryPath(id)}/transfer`, {
    method: "POST",
    body: JSON.stringify({ userId, expectedRevision, ...(reason ? { reason } : {}) }),
  });
}
export function acceptPlatformClawSkillHubTransfer(
  id: string,
  expectedRevision: number,
): Promise<{ ok: true }> {
  return request(`${entryPath(id)}/transfer/accept`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}
export function loadPlatformClawSkillHubNotifications(): Promise<{
  items: PlatformClawSkillHubNotification[];
  unreadCount: number;
}> {
  return request("/notifications");
}
export function markPlatformClawSkillHubNotificationsRead(
  ids?: string[],
): Promise<{ ok: true; updated: number }> {
  return request("/notifications/read", {
    method: "POST",
    body: JSON.stringify(ids ? { ids } : {}),
  });
}

export function cancelPlatformClawSkillHubPublication(
  operationId: string,
  reason?: string,
): Promise<{ ok: true }> {
  return request(`/publications/${encodeURIComponent(operationId)}/cancel`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}
