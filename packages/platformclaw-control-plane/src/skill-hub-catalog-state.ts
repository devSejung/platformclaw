export type SkillHubSharing = {
  mode: "PUBLIC" | "SELECTED" | "PRIVATE";
  userIds: string[];
  scopeIds: string[];
};

export type SkillHubCatalogEntry = {
  id: string;
  registryId: number | null;
  namespace: string;
  slug: string;
  ownerUserId: string | null;
  displayName: string;
  summary: string;
  tags: string[];
  sharing: SkillHubSharing;
  revision: number;
  currentVersion: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  purgedAt: number | null;
  purgePending: boolean;
  pendingTransferUserId: string | null;
  hasIcon: boolean;
};

export type SkillHubCatalogIcon = {
  contentType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
};

export type SkillHubCatalogHistory = {
  id: string;
  skillId: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  version: string | null;
  management: boolean;
  details: Record<string, unknown>;
  createdAt: number;
};

export type SkillHubPublicationReceipt = {
  operationId: string;
  skillId: string;
  actorUserId: string;
  version: string;
  fingerprint: string;
  expectedRevision: number;
  state: "pending" | "completed" | "cancelled";
  createdAt: number;
  updatedAt: number;
};

export type SkillHubCatalogInstallation = {
  operationId: string;
  agentId: string;
  destination: "platform_server" | "assigned_vm";
  targetId: string;
  slug: string;
  skillId: string;
  version: string;
  archiveSha256: string;
  installedRevision: string | null;
  installedAt: number;
  state: "pending" | "completed";
};

type CatalogMutation = {
  skillId: string;
  actorUserId: string;
  expectedRevision: number;
  now: number;
  reason?: string;
};

export interface SkillHubCatalogStore {
  get(id: string): Promise<SkillHubCatalogEntry | null>;
  getByCoordinate(namespace: string, slug: string): Promise<SkillHubCatalogEntry | null>;
  list(): Promise<SkillHubCatalogEntry[]>;
  getIcon(id: string): Promise<SkillHubCatalogIcon | null>;
  blockVersion(params: {
    skillId: string;
    version: string;
    reason: string;
    now: number;
  }): Promise<boolean>;
  getBlockedVersions(skillId: string): Promise<string[]>;
  recordInstallation(
    params: Omit<SkillHubCatalogInstallation, "installedRevision" | "operationId" | "state"> & {
      operationId?: string;
      installedRevision?: string;
      state?: SkillHubCatalogInstallation["state"];
    },
  ): Promise<SkillHubCatalogInstallation>;
  completeInstallation(
    params: Pick<
      SkillHubCatalogInstallation,
      | "operationId"
      | "agentId"
      | "destination"
      | "targetId"
      | "slug"
      | "skillId"
      | "version"
      | "archiveSha256"
    > & { installedRevision?: string; now: number },
  ): Promise<void>;
  listInstallations(agentId: string, targetId: string): Promise<SkillHubCatalogInstallation[]>;
  roomExcludedSlugs(agentId: string): Promise<string[]>;
  removeInstallation(params: {
    agentId: string;
    destination: SkillHubCatalogInstallation["destination"];
    targetId: string;
    slug: string;
    operationId?: string;
  }): Promise<void>;
  canAccess(params: {
    skillId: string;
    userId: string;
    audience?: "employee" | "room";
  }): Promise<boolean>;
  reservePublication(params: {
    operationId: string;
    skillId?: string;
    actorUserId: string;
    slug: string;
    version: string;
    fingerprint: string;
    expectedRevision?: number;
    displayName?: string;
    summary?: string;
    sharing?: SkillHubSharing;
    reason?: string;
    now: number;
  }): Promise<{
    entry: SkillHubCatalogEntry;
    receipt: SkillHubPublicationReceipt;
    reused: boolean;
  }>;
  getPublication(operationId: string): Promise<SkillHubPublicationReceipt | null>;
  listPendingPublications(limit?: number): Promise<SkillHubPublicationReceipt[]>;
  listRecoverablePublications(
    actorUserId: string,
  ): Promise<
    Array<
      SkillHubPublicationReceipt &
        Pick<SkillHubCatalogEntry, "ownerUserId" | "displayName" | "slug">
    >
  >;
  claimPendingPublications(limit?: number): Promise<SkillHubPublicationReceipt[]>;
  bindRegistryIdentity(params: {
    skillId: string;
    registryId: number;
    expectedNamespace: string;
    expectedSlug: string;
  }): Promise<SkillHubCatalogEntry>;
  validatePublication(operationId: string): Promise<SkillHubCatalogEntry>;
  completePublication(params: {
    operationId: string;
    registryId: number;
    now: number;
  }): Promise<SkillHubCatalogEntry>;
  cancelPublication(params: {
    operationId: string;
    actorUserId: string;
    now: number;
    reason?: string;
  }): Promise<void>;
  authorizePublicationCancellation(params: {
    operationId: string;
    actorUserId: string;
    reason?: string;
  }): Promise<SkillHubPublicationReceipt>;
  updateMetadata(
    params: CatalogMutation & {
      displayName?: string;
      summary?: string;
      tags?: string[];
      sharing?: SkillHubSharing;
      icon?: SkillHubCatalogIcon | null;
    },
  ): Promise<SkillHubCatalogEntry>;
  trash(params: CatalogMutation): Promise<SkillHubCatalogEntry>;
  restore(params: CatalogMutation): Promise<SkillHubCatalogEntry>;
  requestTransfer(
    params: CatalogMutation & { recipientUserId: string },
  ): Promise<SkillHubCatalogEntry>;
  acceptTransfer(params: CatalogMutation): Promise<SkillHubCatalogEntry>;
  listTransfers(actorUserId: string): Promise<SkillHubCatalogEntry[]>;
  searchUsers(params: {
    actorUserId: string;
    query: string;
    limit?: number;
  }): Promise<Array<{ id: string; accountId: string; displayName?: string }>>;
  listHistory(params: {
    skillId: string;
    actorUserId: string;
    limit?: number;
  }): Promise<SkillHubCatalogHistory[]>;
  listPurgeDue(now: number, limit?: number): Promise<SkillHubCatalogEntry[]>;
  claimPurgeDue(now: number, limit?: number): Promise<SkillHubCatalogEntry[]>;
  beginPurge(params: {
    skillId: string;
    expectedRevision: number;
    now: number;
  }): Promise<SkillHubCatalogEntry>;
  finishPurge(params: { skillId: string; now: number }): Promise<void>;
  pruneHistory(now: number): Promise<number>;
  importLegacy(params: {
    id: string;
    registryId: number;
    namespace: string;
    slug: string;
    displayName: string;
    summary: string;
    currentVersion: string | null;
    now: number;
  }): Promise<SkillHubCatalogEntry>;
  listLegacyCoordinates(): Promise<Array<{ namespace: string; slug: string }>>;
  migrationComplete(): Promise<boolean>;
  finishMigration(now: number): Promise<void>;
}
