import type { SkillHubVisibility } from "./skill-hub-adapter.js";
import type {
  SkillHubEditableMetadata,
  SkillHubRegistryEdit,
} from "./skill-hub-governance-client.js";

export type SkillHubOwnership = {
  namespace: string;
  slug: string;
  ownerUserId: string | null;
  previousOwnerUserId?: string;
  visibility: SkillHubVisibility;
  currentVersion: string;
  updatedAt: number;
  reconciliationRequired?: boolean;
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
  scopeKind: "global" | "team" | "group" | "part";
  scopeId?: string;
  accessState: "active" | "restricted";
  visibilityCeiling: SkillHubVisibility;
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
};

export type SkillHubManagementUser = {
  id: string;
  accountId: string;
  displayName?: string;
};

export type SkillHubNamespaceCreation = {
  namespace: string;
  operationId: string;
  actorUserId: string;
  scopeKind: SkillHubNamespaceBinding["scopeKind"];
  scopeId?: string;
  state: "pending" | "registry-created" | "completed" | "uncertain" | "failed";
  registryNamespaceId?: number;
  createdAt: number;
  updatedAt: number;
};

export type SkillHubEditPlan = {
  id: string;
  namespace: string;
  slug: string;
  targetNamespace: string;
  skillId: number;
  registryRevision: string;
  displayName: string;
  summary: string;
  visibility: SkillHubVisibility;
  actorUserId: string;
  expectedOwnerUpdatedAt: number;
  expectedSourceBindingUpdatedAt: number;
  expectedTargetBindingUpdatedAt: number;
  changedAt: number;
};

export type SkillHubEditResult = {
  ownership: SkillHubOwnership;
  reconciliationRequired: boolean;
  publicationPending?: boolean;
};

export type SkillHubEditIntent = SkillHubEditPlan & {
  originalOwnership: SkillHubOwnership;
  state: "pending" | "completed" | "cancelled";
  result?: SkillHubEditResult;
  privacy?: SkillHubRegistryEdit;
};

export type SkillHubEditCompletion =
  | { state: "completed"; result: SkillHubEditResult }
  | { state: "privacy-required"; intent: SkillHubEditIntent };

export interface SkillHubStateStore {
  ensureDefaultSkillHubNamespace(params: { actorUserId: string; changedAt: number }): Promise<void>;
  listCompletedSkillHubNamespaces(): Promise<string[]>;
  listSkillHubNamespaceCreations(actorUserId: string): Promise<SkillHubNamespaceCreation[]>;
  beginSkillHubNamespaceCreation(params: {
    namespace: string;
    operationId: string;
    actorUserId: string;
    scopeKind: SkillHubNamespaceBinding["scopeKind"];
    scopeId?: string;
    changedAt: number;
  }): Promise<SkillHubNamespaceCreation>;
  recordSkillHubNamespaceCreation(params: {
    namespace: string;
    operationId: string;
    state: "registry-created" | "uncertain" | "failed";
    registryNamespaceId?: number;
    changedAt: number;
  }): Promise<void>;
  completeSkillHubNamespaceCreation(params: {
    namespace: string;
    operationId: string;
    changedAt: number;
  }): Promise<SkillHubNamespaceBinding>;
  beginSkillHubEdit(params: SkillHubEditPlan): Promise<SkillHubEditIntent>;
  getSkillHubEdit(id: string): Promise<SkillHubEditIntent | null>;
  getSkillHubPendingEdit(namespace: string, slug: string): Promise<SkillHubEditIntent | null>;
  listPendingSkillHubEdits(limit?: number): Promise<SkillHubEditIntent[]>;
  recordSkillHubEditRecoveryAttempt(params: { id: string; attemptedAt: number }): Promise<void>;
  completeSkillHubEdit(params: {
    id: string;
    changedAt: number;
    reviewVersions?: readonly string[];
    publicationPending?: boolean;
    registryMetadata?: SkillHubEditableMetadata;
    privacyConfirmedOperationId?: string;
  }): Promise<SkillHubEditCompletion>;
  rebaseSkillHubEditPrivacy(params: {
    id: string;
    expectedOperationId: string;
    metadata: SkillHubEditableMetadata;
    changedAt: number;
  }): Promise<SkillHubEditIntent>;
  cancelSkillHubEdit(params: {
    id: string;
    actorUserId: string;
    changedAt: number;
    reason: string;
  }): Promise<void>;
  getSkillHubOwnership(namespace: string, slug: string): Promise<SkillHubOwnership | null>;
  recordSkillHubPublication(params: {
    namespace: string;
    slug: string;
    ownerUserId: string;
    expectedOwnerUserId: string | null;
    expectedOwnerUpdatedAt: number | null;
    expectedBindingUpdatedAt: number;
    visibility: SkillHubVisibility;
    version: string;
    changedAt: number;
  }): Promise<SkillHubOwnership>;
  removeSkillHubSkillState(params: {
    namespace: string;
    slug: string;
    actorUserId: string;
    changedAt: number;
  }): Promise<boolean>;
  transferSkillHubOwner(params: {
    namespace: string;
    slug: string;
    expectedOwnerUserId: string | null;
    expectedOwnerUpdatedAt: number;
    ownerUserId: string;
    registryVisibility: SkillHubVisibility;
    actorUserId: string;
    changedAt: number;
  }): Promise<SkillHubOwnership>;
  reconcileInactiveSkillHubOwners(changedAt: number): Promise<{
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
  removeSkillHubAccess(params: {
    namespace: string;
    slug: string;
    userId: string;
    actorUserId: string;
    changedAt: number;
  }): Promise<boolean>;
  searchSkillHubManagementUsers(params: {
    namespace: string;
    slug: string;
    actorUserId: string;
    query: string;
    purpose: "owner" | "access";
    limit: number;
  }): Promise<SkillHubManagementUser[]>;
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
    ownerUserId: string | null;
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
    accessState: SkillHubNamespaceBinding["accessState"];
    visibilityCeiling: SkillHubVisibility;
    expectedUpdatedAt: number | null;
    reason: string;
    actorUserId: string;
    changedAt: number;
  }): Promise<SkillHubNamespaceBinding>;
  setSkillHubNamespaceAccessState(params: {
    namespace: string;
    accessState: SkillHubNamespaceBinding["accessState"];
    expectedUpdatedAt: number;
    reason: string;
    actorUserId: string;
    changedAt: number;
  }): Promise<SkillHubNamespaceBinding>;
  removeSkillHubNamespaceBinding(params: {
    namespace: string;
    expectedUpdatedAt: number;
    reason: string;
    actorUserId: string;
    changedAt: number;
  }): Promise<boolean>;
}
