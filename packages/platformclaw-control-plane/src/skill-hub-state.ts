import type { SkillHubVisibility } from "./skill-hub-adapter.js";

export type SkillHubOwnership = {
  namespace: string;
  slug: string;
  ownerUserId: string | null;
  previousOwnerUserId?: string;
  visibility: SkillHubVisibility;
  currentVersion: string;
  updatedAt: number;
};

export type SkillHubAccessGrant = {
  namespace: string;
  slug: string;
  userId: string;
  grantedByUserId: string;
  expiresAt?: number;
  inheritVersions: boolean;
  grantedVersion?: string;
  canReshare: false;
  createdAt: number;
  updatedAt: number;
};

export type SkillHubNotification = {
  id: string;
  kind: string;
  namespace?: string;
  slug?: string;
  message: string;
  createdAt: number;
  readAt?: number;
};

export type SkillHubGovernanceJob = {
  namespace: string;
  slug: string;
  version: string;
  ownerUserId: string | null;
  state: "pending" | "approved" | "blocked" | "failed";
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  updatedAt: number;
};

export type SkillHubNamespaceBinding = {
  namespace: string;
  scopeKind: "team" | "group" | "part";
  scopeId?: string;
  visibilityCeiling: SkillHubVisibility;
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
};

export interface SkillHubStateStore {
  getSkillHubOwnership(namespace: string, slug: string): Promise<SkillHubOwnership | null>;
  recordSkillHubPublication(params: {
    namespace: string;
    slug: string;
    ownerUserId: string;
    visibility: SkillHubVisibility;
    version: string;
    changedAt: number;
  }): Promise<SkillHubOwnership>;
  transferSkillHubOwner(params: {
    namespace: string;
    slug: string;
    expectedOwnerUserId: string | null;
    ownerUserId: string;
    changedAt: number;
  }): Promise<SkillHubOwnership>;
  reconcileInactiveSkillHubOwners(
    changedAt: number,
    primaryAdminUserId?: string,
  ): Promise<{
    reassigned: number;
    unassigned: number;
  }>;
  countUnassignedSkillHubSkills(): Promise<number>;
  listUnassignedSkillHubSkills(): Promise<SkillHubOwnership[]>;
  listSkillHubAccess(namespace: string, slug: string, now: number): Promise<SkillHubAccessGrant[]>;
  hasSkillHubAccess(params: {
    namespace: string;
    slug: string;
    userId: string;
    version?: string;
    now: number;
  }): Promise<boolean>;
  setSkillHubAccess(params: {
    namespace: string;
    slug: string;
    userId: string;
    grantedByUserId: string;
    expiresAt?: number;
    inheritVersions: boolean;
    grantedVersion?: string;
    changedAt: number;
  }): Promise<SkillHubAccessGrant>;
  removeSkillHubAccess(namespace: string, slug: string, userId: string): Promise<boolean>;
  createSkillHubNotification(params: {
    userId: string;
    kind: string;
    namespace?: string;
    slug?: string;
    message: string;
    createdAt: number;
  }): Promise<SkillHubNotification>;
  listSkillHubNotifications(userId: string, limit: number): Promise<SkillHubNotification[]>;
  countUnreadSkillHubNotifications(userId: string): Promise<number>;
  markSkillHubNotificationsRead(params: {
    userId: string;
    ids?: readonly string[];
    readAt: number;
  }): Promise<number>;
  enqueueSkillHubGovernanceJob(params: {
    namespace: string;
    slug: string;
    version: string;
    ownerUserId: string;
    createdAt: number;
  }): Promise<void>;
  listDueSkillHubGovernanceJobs(now: number, limit: number): Promise<SkillHubGovernanceJob[]>;
  updateSkillHubGovernanceJob(params: {
    namespace: string;
    slug: string;
    version: string;
    state: SkillHubGovernanceJob["state"];
    attempts: number;
    nextAttemptAt: number;
    lastError?: string;
    updatedAt: number;
  }): Promise<void>;
  getSkillHubNamespaceBinding(namespace: string): Promise<SkillHubNamespaceBinding | null>;
  listSkillHubNamespaceBindings(): Promise<SkillHubNamespaceBinding[]>;
  setSkillHubNamespaceBinding(params: {
    namespace: string;
    scopeKind: SkillHubNamespaceBinding["scopeKind"];
    scopeId?: string;
    visibilityCeiling: SkillHubVisibility;
    actorUserId: string;
    changedAt: number;
  }): Promise<SkillHubNamespaceBinding>;
  removeSkillHubNamespaceBinding(namespace: string): Promise<boolean>;
  hasSkillHubNamespaceAccess(userId: string, binding: SkillHubNamespaceBinding): Promise<boolean>;
}
